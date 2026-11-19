window.__ModuleLoader__.load({
  id: '@imaegoo/dsh-open-viewed-image',
  factory(require) {
    /** The one tool whose calls open an image in the Sidebar. */
    const READ_IMAGE = 'read_image'

    /** The kind the file-preview tab type registers under; it claims file addresses. */
    const FILE_TAB_KIND = 'text'

    /** Extensions the Sidebar's own document preview renders as pictures. */
    const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg']

    /** The scheme and type every file address opens with. */
    const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'

    /**
     * The lowercased extension of a path, ignoring a query or fragment.
     * @param path - a filesystem path.
     * @returns the extension without its dot, or an empty string.
     */
    function extensionOf(path) {
      const plain = path.split(/[?#]/, 1)[0] ?? path
      const slash = Math.max(plain.lastIndexOf('/'), plain.lastIndexOf('\\'))
      const dot = plain.lastIndexOf('.')
      return dot > slash ? plain.slice(dot + 1).toLowerCase() : ''
    }

    /**
     * Component-encode one address segment, keeping `:` literal for drive letters.
     * @param segment - one id or path segment.
     * @returns the encoded segment.
     */
    function encodeSegment(segment) {
      return encodeURIComponent(segment).replace(/%3A/gi, ':')
    }

    /**
     * Build the Session-scoped file address the preview type claims.
     * Mirrors the `dsh-resource://file/session/<id>/<path>` grammar so this
     * bundle needs no import from a Harness package.
     * @param sessionId - the Session whose workspace resolves the path.
     * @param path - absolute or workspace-relative path.
     * @returns the encoded address.
     */
    function fileAddress(sessionId, path) {
      const normalized = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
      const encoded = normalized.split('/').map(encodeSegment).join('/')
      return `${FILE_ADDRESS_PREFIX}session/${encodeSegment(sessionId)}/${encoded}`
    }

    /**
     * Whether a tab's content address names an image.
     * @param address - the claimed tab's content id.
     * @returns whether it is a file address ending in an image extension.
     */
    function isImageAddress(address) {
      return address.startsWith(FILE_ADDRESS_PREFIX)
        && IMAGE_EXTENSIONS.includes(extensionOf(address))
    }

    /**
     * Read the `file_path` out of a recorded `read_image` call.
     * The arguments are the model's raw JSON, so a malformed payload opens
     * nothing rather than guessing. Only paths the Sidebar previews as pictures
     * are returned: `read_image` also accepts extensionless paths identified by
     * content, and those would open a text tab over binary bytes.
     * @param argsRaw - `tool/call.data.arguments`.
     * @returns the requested image path, or null when it is not one.
     */
    function imagePathFrom(argsRaw) {
      let args
      try {
        args = JSON.parse(argsRaw)
      } catch {
        return null
      }
      if (args === null || typeof args !== 'object' || Array.isArray(args)) return null
      const path = args.file_path
      if (typeof path !== 'string' || path.trim() === '') return null
      return IMAGE_EXTENSIONS.includes(extensionOf(path)) ? path : null
    }

    /**
     * One Session's fold over its event feed.
     *
     * Opening is a side effect, so folding only records candidates and
     * {@link Watcher.take} drains them from the owning effect. A call is paired
     * with its result by id, and a replayed window cannot open one image twice.
     */
    class Watcher {
      constructor() {
        /** Calls seen but not yet settled: callId → path. */
        this.pending = new Map()
        /** callIds already opened. */
        this.opened = new Set()
        /** Paths awaiting the next drain, oldest first. */
        this.ready = []
        /** Highest seq already folded. */
        this.through = -1
      }

      /**
       * Fold one durable event.
       * @param event - a Session event.
       */
      fold(event) {
        if (event.type === 'tool/call') {
          if (event.data.name !== READ_IMAGE) return
          const path = imagePathFrom(event.data.arguments)
          if (path !== null) this.pending.set(String(event.data.callId), path)
          return
        }
        if (event.type !== 'tool/result') return
        // A failed read produced no image to show.
        if (event.data.message.isError === true) return
        const callId = String(event.data.message.source.callId)
        const path = this.pending.get(callId)
        if (path === undefined) return
        this.pending.delete(callId)
        if (this.opened.has(callId)) return
        this.opened.add(callId)
        this.ready.push(path)
      }

      /**
       * Fold entries newer than the last fold.
       * @param entries - window entries, or just the delta.
       */
      absorb(entries) {
        for (const entry of entries) {
          if (entry.type !== 'event') continue
          const event = entry.event
          if (event.seq <= this.through) continue
          this.fold(event)
          if (event.seq > this.through) this.through = event.seq
        }
      }

      /**
       * Advance past entries without opening any of them. Used for history,
       * which arrives as a whole window rather than as live appends: a Session
       * opened now must not spray the images it read in the past across the
       * Sidebar.
       * @param entries - window entries to step over.
       */
      skip(entries) {
        for (const entry of entries) {
          if (entry.type !== 'event') continue
          if (entry.event.seq > this.through) this.through = entry.event.seq
        }
      }

      /**
       * Advance past history without opening any of it, so watching a Session
       * does not replay the images it read before this plugin loaded.
       * @param entries - the binding's current window entries.
       */
      prime(entries) {
        this.skip(entries)
        this.pending.clear()
        this.ready.length = 0
      }

      /**
       * Take the paths that became ready since the last drain.
       * @returns paths in the order they were read.
       */
      take() {
        const ready = this.ready
        this.ready = []
        return ready
      }
    }

    return {
      // The feature is the right column itself, so the column is a hard
      // dependency: without it this bundle stays inactive instead of running
      // and opening nothing.
      inject: ['sessions', 'sidebarRight'],
      apply(ctx) {
        /** The right column's navigation face. */
        const rightbar = () => ctx.sidebarRight

        /**
         * The image tab already open in this Session, which a new image
         * replaces so the column shows one picture instead of a growing strip.
         * @param sessionId - the Session being viewed.
         * @returns that tab's id, if one is open.
         */
        const replaceableTab = (sessionId) => {
          let found
          for (const tab of rightbar().openTabs.getSnapshot()) {
            if (tab.sessionId !== sessionId) continue
            if (tab.kind !== FILE_TAB_KIND) continue
            if (!isImageAddress(tab.contentId)) continue
            found = tab.tabId
          }
          return found
        }

        /**
         * Open one image in the right Sidebar, replacing the previous one.
         * @param sessionId - the Session whose workspace resolves the path.
         * @param path - the image path the agent read.
         */
        const openImage = (sessionId, path) => {
          const replaceTab = replaceableTab(sessionId)
          try {
            rightbar().openResource(
              fileAddress(sessionId, path),
              replaceTab === undefined ? undefined : { replaceTab },
            )
          } catch (error) {
            // An address no tab type claims throws by contract. That is a
            // composition without the file preview, not a user-facing failure.
            console.error('[open-viewed-image] could not open', path, error)
          }
        }

        /**
         * Follow one Session's event feed.
         * @param sessionId - the Session to watch.
         * @returns a disposer.
         */
        const watch = (sessionId) => {
          const binding = ctx.sessions.binding(sessionId)
          if (binding === undefined) return () => {}
          const source = binding.eventSource
          const watcher = new Watcher()
          watcher.prime(source.getSnapshot().entries)
          let draining = false
          const drain = () => {
            if (draining) return
            draining = true
            try {
              for (const path of watcher.take()) openImage(sessionId, path)
            } finally {
              draining = false
            }
          }
          const unsubscribe = source.subscribe(() => {
            const window = source.getSnapshot()
            // Only a live append is "the agent just read this". Any other
            // change is history arriving (a reloaded or grown window), and the
            // images in it were read before this watcher existed.
            const change = window.change
            if (change.kind !== 'append') {
              watcher.skip(window.entries)
              return
            }
            watcher.absorb(change.entries)
            drain()
          })
          // The window present at subscription time is history, not news.
          watcher.prime(source.getSnapshot().entries)
          return () => { unsubscribe() }
        }

        // Watch exactly the Session the conversation is showing: reading an
        // image matters in the Session the user is looking at, and `mounted`
        // changes before React renders the switch it describes.
        ctx.effect(() => {
          const disposers = new Map()
          const sync = () => {
            const mounted = rightbar().mounted.getSnapshot()
            for (const [sessionId, dispose] of disposers) {
              if (sessionId === mounted) continue
              dispose()
              disposers.delete(sessionId)
            }
            if (mounted !== undefined && !disposers.has(mounted)) {
              disposers.set(mounted, watch(mounted))
            }
          }
          const unsubscribe = rightbar().mounted.subscribe(sync)
          sync()
          return () => {
            unsubscribe()
            for (const dispose of disposers.values()) dispose()
            disposers.clear()
          }
        }, 'open-viewed-image: follow the viewed Session')
      },
    }
  },
})
