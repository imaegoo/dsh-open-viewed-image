/**
 * Host half of the open-viewed-image bundle.
 *
 * The browser half does all the work: it folds `read_image` calls out of the
 * Session event feed and opens the file in the right Sidebar. Nothing here is
 * model-visible, so the Host registers no tool, prompt section, or event.
 */
export function apply() {}
