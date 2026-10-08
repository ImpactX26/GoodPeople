/**
 * Print just one thing on the page (a label, a certificate, a report): it's marked while the print dialog is
 * open, and the print styles in globals.css hide everything else.
 */
export function printOnly(el: HTMLElement | null) {
  if (!el) return;
  el.setAttribute("data-printing", "");
  const done = () => { el.removeAttribute("data-printing"); window.removeEventListener("afterprint", done); };
  window.addEventListener("afterprint", done);
  window.print();
}
