/* The dot carries the app's one accent color; the sidebar's active-page
   marker repeats it, so the mark and the navigation speak the same detail. */
export function Wordmark() {
  return (
    <>
      vocab<span className="dot">·</span>builder
    </>
  );
}
