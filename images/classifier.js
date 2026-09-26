const KEYWORDS = {
  wallpaper: ["wallpaper", "iphone", "background", "lockscreen"],
  pfp: ["pfp", "profile picture", "avatar"],
  couple: ["couple", "lovers", "love", "relationship", "romantic", "holding hands"],
  movie: ["movie", "film", "netflix", "poster", "cinema"],
  anime: ["anime", "manga"],
  flower: ["flower", "rose", "tulip", "bouquet"],
  nature: ["nature", "forest", "sunset", "ocean", "sky", "mountain"],
  sad: ["sad", "lonely", "heartbreak", "crying", "alone"],
  cute: ["cute", "kawaii", "soft girl", "pink"],
  nostalgic: ["nostalgic", "vintage", "retro", "old memories"],
  quote: ["quote", "quotes", "text", "words"]
};

export function classifyText(text = "") {
  const normalized = text.toLowerCase();
  const scores = Object.entries(KEYWORDS).map(([label, words]) => ({
    label,
    score: words.reduce((sum, word) => sum + (normalized.includes(word) ? 1 : 0), 0)
  }));

  scores.sort((a, b) => b.score - a.score);

  return {
    label: scores[0]?.score ? scores[0].label : "other",
    scores
  };
}

export function classifyPin(pin, category) {
  const text = [
    pin?.title,
    pin?.description,
    pin?.alt_text,
    pin?.note,
    category
  ].filter(Boolean).join(" ");

  return classifyText(text);
}
