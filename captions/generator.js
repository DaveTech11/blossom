const BRAND = "𓍢ִ໋🌷";
const SYMBOLS = ["♡", "୨୧", "✧", "⟡", "𓂃", "˚₊‧", "☾", "⋆"];

const BANK = {
  wallpaper: [
    "soft little corner of the day",
    "a little softness for your screen",
    "saving this one for later",
    "something pretty for your lockscreen",
    "a quiet little view",
    "this feels like a dream",
    "your screen deserves this softness"
  ],
  pfp: [
    "new pfp energy",
    "this one belongs on your profile",
    "a little identity upgrade",
    "your next pfp perhaps?",
    "soft profile energy",
    "this deserves a spot in your favorites"
  ],
  couple: [
    "you, me, and a little forever.",
    "maybe love is supposed to feel this soft.",
    "somewhere between us and forever.",
    "the kind of love that feels like home.",
    "love, but make it quiet.",
    "a little romance for the timeline."
  ],
  movie: [
    "tonight's pick 🎬 — save this one for later.",
    "adding this one to the movie-night list.",
    "your next comfort movie might be this.",
    "movie night idea 🎬",
    "one for the watchlist.",
    "save this for your next movie night."
  ],
  sad: [
    "some nights just feel a little quieter.",
    "some feelings don't need a name.",
    "quietly existing between yesterday and tomorrow.",
    "maybe silence has its own language.",
    "for the nights that feel a little heavier."
  ],
  nostalgic: [
    "wish we could pause certain moments.",
    "a tiny piece of another time.",
    "some memories never really leave.",
    "this feels like a memory.",
    "for the moments we wish we could keep."
  ],
  quote: [
    "a little reminder for today.",
    "keep this one close.",
    "maybe you needed to see this today.",
    "words for a quiet moment.",
    "let this one sit with you."
  ],
  default: [
    "a little piece of the mood.",
    "keeping this one close.",
    "softly saving this moment.",
    "for your little corner of the internet.",
    "this one feels different."
  ]
};

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function moodFor(classification) {
  const label = classification?.label;
  if (["sad", "nostalgic", "couple", "movie", "pfp", "wallpaper", "quote"].includes(label)) {
    return label;
  }
  return "default";
}

export function generateCaption({ category, classification, pin, query }) {
  const search = String(query || "").trim().toLowerCase();
  const words = search.split(/\s+/).filter(Boolean);
  const prettyQuery = search.replace(/\s+/g, " ").trim();

  // Make the caption reflect what the user actually searched for.
  // This is intentionally based on the query itself, not a generic category.
  if (prettyQuery) {
    const tag = words.slice(0, 8).map(w => `#${w.replace(/[^a-z0-9_]/gi, "")}`).filter(Boolean).join(" ");
    const queryCaptions = [
      `found from your search: “${prettyQuery}”`,
      `your search mood — ${prettyQuery}`,
      `picked for “${prettyQuery}”`,
      `searching the mood of “${prettyQuery}”`,
      `a little ${prettyQuery} energy for your feed`
    ];
    return `${pick(queryCaptions)} ${pick(SYMBOLS)}${tag ? `\n${tag}` : ""}`;
  }
  const label = moodFor(classification);

  // Movie titles are taken only from metadata returned by the API; no OCR or
  // external lookup is performed here.
  if (category === "movies" && pin?.title) {
    return `${pick(BANK.movie)} ${pin.title.trim()} ${pick(SYMBOLS)}`;
  }

  return `${pick(BANK[label] || BANK.default)} ${pick(SYMBOLS)}`;
}
