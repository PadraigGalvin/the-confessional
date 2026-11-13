// Everything guests see, in each language the booth speaks, plus the film's titles.
// The booth (app.js), the server (for the questions) and scripts/compile.js (for the
// film) all import this file, so it holds plain data and no browser code.
//
// Write French with ordinary spaces before ? ! : ; and inside « ». typeset() swaps in
// the narrow no-break space French uses, so a ? never wraps onto a line of its own.
// Guests are "tu", to keep things informal.

const fr = {
  languageName: 'Français',
  languageNameInEnglish: 'French',
  languageLabel: 'Langue',
  locale: 'fr-FR',

  pageTitle: 'Le confessionnal',
  previewLabel: 'Aperçu de la caméra en direct',
  loadingLabel: 'Un instant',
  loadingText: 'On réveille la caméra…',

  startTitle: 'Qui passe à confesse ?',
  startNote: (count, seconds) =>
    `Tu vas avoir ${count} question${count > 1 ? 's' : ''}, avec jusqu'à ${seconds} secondes ` +
    `${count > 1 ? 'pour chacune' : 'pour répondre'}. Tout ce que tu dis est enregistré pour le film d'anniversaire.`,
  formLabel: 'Ton nom, et une petite phrase si tu veux',
  namePlaceholder: 'Ton nom',
  nameLabel: 'Ton nom, ou les noms de tout le monde si vous êtes en groupe',
  taglinePlaceholder: (birthday) => `Ta phrase, genre « Connaît ${birthday} depuis toujours, paraît-il »`,
  taglineLabel: 'Ta petite phrase (facultatif)',
  startButton: 'Moteur',
  keyEnter: 'Entrée',
  keySpace: 'Espace',

  countdownLabel: 'On tourne dans',
  countdownText: "Regarde la webcam, juste au-dessus de l'écran.",

  questionProgress: (number, total) => `Question ${number} sur ${total}`,
  nextQuestion: 'Question suivante',
  finish: 'Terminer',
  timeLeft: (time) => `Encore ${time}`,

  thanksTitle: "C'est dans la boîte,",
  thanksNote: (answered, seconds) => {
    const s = answered > 1 ? 's' : ''; // 0 and 1 are both singular in French
    return `${answered} réponse${s} enregistrée${s} · au suivant dans ${seconds}`;
  },

  errorLabel: 'Incident technique',
  settings: 'Réglages',
  retry: 'Réessayer',
  errorNoServer: "Impossible de joindre le serveur du confessionnal. Vérifie qu'il tourne, puis réessaie.",
  errorNoSession: "Le confessionnal n'a pas pu démarrer. Vérifie que le serveur tourne, puis réessaie.",
  errorNoRecorder: 'Ce navigateur ne sait pas enregistrer de vidéo. Ouvre le confessionnal dans Google Chrome ou Microsoft Edge.',
  errorDisconnected: 'La caméra ou le micro a été débranché. Rebranche-le, puis réessaie.',
  cameraBlocked: "L'accès à la caméra est bloqué. Autorise la caméra et le micro pour cette page dans les réglages du navigateur, puis réessaie.",
  cameraMissing: 'Aucune caméra ni aucun micro trouvé. Branche-les, puis réessaie.',
  cameraBusy: 'La caméra est utilisée par une autre application. Ferme-la, puis réessaie.',
  cameraFailed: (message) => `La caméra n'a pas pu démarrer (${message}). Réessaie.`,
  unknownError: 'erreur inconnue',

  // The show's name, in the corner of the booth and all through the film.
  showName: 'Le Week-end',
  filmIntroLabel: 'Confessions face caméra',
  filmCardLabel: 'On a demandé',
  filmCreditsLabel: 'Avec',
  filmChapterIntro: 'Générique',
  filmChapterWrap: 'Joyeux anniversaire',
  filmChapterCredits: 'Générique de fin',
};

const en = {
  languageName: 'English',
  languageNameInEnglish: 'English',
  languageLabel: 'Language',
  locale: 'en-GB',

  pageTitle: 'Confession booth',
  previewLabel: 'Live camera preview',
  loadingLabel: 'Stand by',
  loadingText: 'Waking up the camera…',

  startTitle: "Who's in the hot seat?",
  startNote: (count, seconds) =>
    `You'll get ${count} question${count === 1 ? '' : 's'}, with up to ${seconds} seconds for each. ` +
    'Everything you say is recorded for the birthday film.',
  formLabel: 'Your name, plus a tagline if you want one',
  namePlaceholder: 'Your name',
  nameLabel: "Your name, or everyone's names if you're in a group",
  taglinePlaceholder: (birthday) => `Your tagline, like “${birthday}'s oldest friend, allegedly”`,
  taglineLabel: 'Your tagline (optional)',
  startButton: 'Roll camera',
  keyEnter: 'Enter',
  keySpace: 'Space',

  countdownLabel: 'Rolling in',
  countdownText: 'Look at the webcam, just above the screen.',

  questionProgress: (number, total) => `Question ${number} of ${total}`,
  nextQuestion: 'Next question',
  finish: 'Finish',
  timeLeft: (time) => `${time} left`,

  thanksTitle: "That's a wrap,",
  thanksNote: (answered, seconds) => `${answered} answer${answered === 1 ? '' : 's'} saved · next guest in ${seconds}`,

  errorLabel: 'Technical difficulties',
  settings: 'Settings',
  retry: 'Try again',
  errorNoServer: "Can't reach the booth server. Check it's running, then try again.",
  errorNoSession: "The booth couldn't start a session. Check the booth server is running, then try again.",
  errorNoRecorder: 'This browser cannot record video. Open the booth in Google Chrome or Microsoft Edge.',
  errorDisconnected: 'The camera or microphone was disconnected. Plug it back in, then try again.',
  cameraBlocked: 'Camera access is blocked. Allow the camera and microphone for this page in the browser settings, then try again.',
  cameraMissing: 'No camera or microphone was found. Plug them in, then try again.',
  cameraBusy: 'The camera is being used by another app. Close that app, then try again.',
  cameraFailed: (message) => `The camera couldn't start (${message}). Try again.`,
  unknownError: 'unknown error',

  showName: 'The Weekend',
  filmIntroLabel: 'Confessions from the booth',
  filmCardLabel: 'We asked',
  filmCreditsLabel: 'Starring',
  filmChapterIntro: 'Opening titles',
  filmChapterWrap: 'Happy birthday',
  filmChapterCredits: 'Credits',
};

// French puts a narrow no-break space before ? ! : ; and inside « ». This adds it
// wherever a plain space (or none) was typed. A colon in "1:30" is left alone.
export function typeset(text, language) {
  if (language !== 'fr' || !text) return text;
  const space = '\u202F'; // narrow no-break space
  return text
    .replace(/(\S)[ \u00A0\u202F]*([?!:;]+)(?=[\s»"')]|$)/g, `$1${space}$2`)
    .replace(/«[ \u00A0\u202F]*/g, `«${space}`)
    .replace(/[ \u00A0\u202F]*»/g, `${space}»`);
}

const ELIDING_WORDS = /\b(de|que|jusque|lorsque|puisque|quoique) \{birthday\}/gi;

// Fills in {birthday}. In French, "de" and "que" before a name starting with a vowel
// become "d'" and "qu'": "l'imitation d'Anne", not "de Anne". Names starting with h
// are left alone, because some take the elision and some don't.
export function fillBirthday(text, birthdayName, language) {
  let filled = text;
  if (language === 'fr' && /^[aeiouyæœ]/i.test(birthdayName.normalize('NFD'))) {
    filled = filled.replace(ELIDING_WORDS, (_, word) => `${word.slice(0, -1)}'${birthdayName}`);
  }
  return filled.replaceAll('{birthday}', birthdayName);
}

// The languages in `list` (from config.json) that this file has text for, without repeats.
export function knownLanguages(list) {
  return [...new Set(Array.isArray(list) ? list : [])].filter((code) => Object.hasOwn(STRINGS, code));
}

// Runs every French string, and the result of every French function, through typeset().
function typesetAll(strings, language) {
  return Object.fromEntries(Object.entries(strings).map(([key, value]) => [
    key,
    typeof value === 'function' ? (...args) => typeset(value(...args), language) : typeset(value, language),
  ]));
}

export const STRINGS = { fr: typesetAll(fr, 'fr'), en };
