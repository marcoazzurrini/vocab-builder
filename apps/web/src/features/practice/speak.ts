/**
 * Temporary. Browser voices vary by device and are often poor, and §6 has you
 * repeating aloud — so you imitate whatever you hear, and a bad voice teaches
 * bad pronunciation. This is a stand-in until pre-generated clips exist.
 *
 * Deliberately not silent on failure: the PoC swallowed errors in a bare
 * try/catch, which meant the one principle present on every single card could
 * stop working without anything saying so.
 */
export const speak = (
  text: string,
  onUnavailable?: (reason: string) => void
): void => {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    onUnavailable?.("Questo browser non supporta la sintesi vocale.");
    return;
  }

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "fr-FR";
  utterance.rate = 0.85;

  // Chrome populates voices asynchronously, so the first call of a session
  // often sees an empty list. Falling back to lang alone still speaks French.
  const french = window.speechSynthesis
    .getVoices()
    .find((v) => v.lang?.startsWith("fr"));
  if (french) {
    utterance.voice = french;
  }

  utterance.addEventListener("error", (event) =>
    onUnavailable?.(`Audio non riuscito (${event.error}).`)
  );

  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
};

/** Ask the browser to load voices early, so the first card is not the slow one. */
export const warmUpVoices = (): void => {
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    window.speechSynthesis.getVoices();
  }
};
