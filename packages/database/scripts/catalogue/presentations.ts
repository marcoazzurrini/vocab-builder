import type { EntryPresentation } from "@vocab/spaced-repetition";

import type { CurriculumStep } from "./curriculum";
import { contentHash } from "./hash";

export const PRESENTATION_VERSION = 1;

export type EditorialEntry = Pick<
  EntryPresentation,
  "meaning" | "context" | "explanation" | "example"
>;
const entry = (
  meaning: string,
  context: string,
  explanation: string,
  text: string,
  translation: string
): EditorialEntry => ({
  context,
  example: { text, translation },
  explanation,
  meaning,
});

// These clarify the existing selected meanings. They do not replace a sense,
// transfer progress, or claim independent dictionary review. Keep usage examples
// out of recall prompts: their French text is teaching material only.
const editorial = new Map<string, EditorialEntry>([
  [
    "être",
    entry(
      "essere",
      "Per indicare dove si trova qualcuno o qualcosa.",
      "Qui impari l'infinito être, cioè il verbo essere. Il luogo completa l'esempio: nella risposta dovrai scrivere solo il verbo.",
      "être à la maison",
      "essere a casa"
    ),
  ],
  [
    "avoir",
    entry(
      "avere",
      "Nel senso di possedere qualcosa.",
      "Avoir è l'infinito del verbo avere. Nella risposta scrivi il verbo, non l'oggetto che segue nell'esempio.",
      "avoir un livre",
      "avere un libro"
    ),
  ],
  [
    "aller",
    entry(
      "andare",
      "Muoversi verso una destinazione.",
      "Aller significa andare. Qui impari l'infinito; le forme come je vais si imparano in seguito.",
      "aller à Paris",
      "andare a Parigi"
    ),
  ],
  [
    "faire",
    entry(
      "fare",
      "Compiere un'azione.",
      "Faire è l'infinito. Qui impari il verbo, non l'intera espressione dell'esempio.",
      "faire un gâteau",
      "fare una torta"
    ),
  ],
  [
    "pouvoir",
    entry(
      "potere",
      "Essere in grado di fare qualcosa.",
      "Pouvoir si usa prima di un altro verbo all'infinito. Nella risposta serve solo pouvoir.",
      "pouvoir venir",
      "poter venire"
    ),
  ],
  [
    "dire",
    entry(
      "esprimere a parole",
      "Il verbo usato per comunicare qualcosa con le parole.",
      "Il verbo francese dire si scrive come quello italiano. L'esempio mostra un suo uso; la risposta è solo dire.",
      "dire la vérité",
      "dire la verità"
    ),
  ],
  [
    "vouloir",
    entry(
      "volere",
      "Desiderare qualcosa o voler fare qualcosa.",
      "Vouloir è il verbo all'infinito. Non aggiungere il verbo che segue nell'esempio.",
      "vouloir partir",
      "voler partire"
    ),
  ],
  [
    "savoir",
    entry(
      "sapere",
      "Conoscere un fatto o un'informazione.",
      "Savoir si usa per informazioni e fatti. Per conoscere una persona si usa invece connaître: è un altro verbo.",
      "savoir la réponse",
      "sapere la risposta"
    ),
  ],
  [
    "bien",
    entry(
      "bene",
      "Come avverbio: descrive come si svolge un'azione.",
      "Bien significa bene, non buono. In questa lezione impari l'avverbio.",
      "bien travailler",
      "lavorare bene"
    ),
  ],
  [
    "non",
    entry(
      "no",
      "Una risposta negativa.",
      "Non è la risposta no. Non confonderlo con la parola italiana non, che si usa davanti a un verbo.",
      "Non, merci.",
      "No, grazie."
    ),
  ],
  [
    "devoir",
    entry(
      "dovere",
      "Essere obbligato a fare qualcosa.",
      "Qui devoir è un verbo all'infinito. Può essere seguito da un altro infinito.",
      "devoir partir",
      "dover partire"
    ),
  ],
  [
    "tout",
    entry(
      "tutto",
      "L'intera quantità; forma maschile singolare.",
      "Qui impari la forma tout. Altre forme, come toute e tous, dipendono dal genere e dal numero.",
      "tout le temps",
      "tutto il tempo"
    ),
  ],
  [
    "plus",
    entry(
      "più",
      "Una quantità maggiore, non una negazione.",
      "Qui plus indica una quantità maggiore. In una frase negativa può avere un altro uso, che non è quello di questa lezione.",
      "plus de temps",
      "più tempo"
    ),
  ],
  [
    "voir",
    entry(
      "vedere",
      "Percepire con gli occhi.",
      "Voir è l'infinito di vedere. Non significa guardare intenzionalmente: per quel senso si usa spesso regarder.",
      "voir la mer",
      "vedere il mare"
    ),
  ],
  [
    "oui",
    entry(
      "sì",
      "Una normale risposta affermativa.",
      "Oui è il sì usato per confermare. Per contraddire una negazione il francese usa si, che si impara separatamente.",
      "Oui, merci.",
      "Sì, grazie."
    ),
  ],
  [
    "si",
    entry(
      "sì, invece",
      "Una risposta che contraddice una negazione.",
      "Si corregge una negazione: non è il normale sì di conferma, che in francese è oui.",
      "Tu ne viens pas ? — Si !",
      "Non vieni? — Sì, invece!"
    ),
  ],
  [
    "venir",
    entry(
      "venire",
      "Muoversi verso chi parla o verso un punto di riferimento.",
      "Venir è l'infinito di venire. Il contesto serve a distinguerlo da aller, andare.",
      "venir ici",
      "venire qui"
    ),
  ],
  [
    "ici",
    entry(
      "qui",
      "Nel luogo in cui si trova chi parla.",
      "Ici indica questo luogo. Nella risposta serve una sola parola.",
      "Je suis ici.",
      "Sono qui."
    ),
  ],
  [
    "là",
    entry(
      "lì",
      "In quel luogo.",
      "Là si scrive con l'accento sulla à. Senza accento, la è un'altra parola.",
      "Il est là.",
      "È lì."
    ),
  ],
  [
    "chose",
    entry(
      "cosa",
      "Un oggetto o qualcosa non specificato.",
      "Chose è un nome femminile: une chose. Qui dovrai ricordare il nome, senza l'articolo.",
      "une chose importante",
      "una cosa importante"
    ),
  ],
  [
    "penser",
    entry(
      "pensare",
      "Formare un pensiero.",
      "Penser è l'infinito. La forma je pense, io penso, si studia separatamente.",
      "penser à demain",
      "pensare a domani"
    ),
  ],
  [
    "parler",
    entry(
      "parlare",
      "Comunicare usando la voce e le parole.",
      "Parler è un verbo regolare in -er. Qui impari l'infinito; più avanti userai forme come je parle.",
      "parler français",
      "parlare francese"
    ),
  ],
]);

const grammarLabels = new Map([
  ["ADJ", "aggettivo"],
  ["ADV", "avverbio"],
  ["AUX", "verbo ausiliare · infinito"],
  ["CON", "congiunzione"],
  ["NOM", "nome"],
  ["PRE", "preposizione"],
  ["PRO", "pronome"],
  ["VER", "verbo · infinito"],
]);

export const presentationSourceHash = contentHash({
  editorial: [...editorial],
  grammar: Object.fromEntries(grammarLabels),
  policy:
    "Separate the final parenthetical qualifier from the Italian meaning. Keep the historical cue and answer immutable. Form prompts request the verb without a pronoun. Usage examples and explanations are teaching-only.",
  version: PRESENTATION_VERSION,
});

const splitCue = (cue: string) => {
  const withoutInstruction = cue.replace(
    / — solo il verbo, senza pronome$/u,
    ""
  );
  const match = /^(?<meaning>.*?) \((?<context>[^()]*)\)$/u.exec(
    withoutInstruction
  );
  return {
    context: match?.groups?.context ?? null,
    meaning: match?.groups?.meaning ?? withoutInstruction,
  };
};

export const presentationFor = (step: CurriculumStep): EntryPresentation => {
  const cue = splitCue(step.cue);
  const authored = step.form_id ? undefined : editorial.get(step.text);
  return {
    context: authored?.context ?? cue.context,
    example: authored?.example ?? null,
    explanation: authored?.explanation ?? step.note,
    grammar: step.form_id
      ? "verbo · presente · senza pronome"
      : (grammarLabels.get(step.part_of_speech) ?? null),
    meaning: authored?.meaning ?? cue.meaning,
  };
};
