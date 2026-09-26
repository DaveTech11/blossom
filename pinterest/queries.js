export const QUERY_GROUPS = {
  wallpapers: [
    "aesthetic wallpapers",
    "cute wallpapers",
    "iphone wallpapers",
    "dark wallpapers",
    "pink wallpapers",
    "flower wallpapers",
    "minimalist wallpapers",
    "anime wallpapers",
    "vintage wallpapers",
    "dreamy wallpapers",
    "night wallpapers",
    "nature wallpapers",
    "romantic wallpapers"
  ],
  pfp: [
    "aesthetic profile pictures",
    "cute pfp",
    "anime pfp",
    "girl pfp",
    "boy pfp",
    "dark pfp",
    "pink pfp",
    "vintage pfp",
    "couple pfp",
    "matching pfp",
    "minimalist pfp",
    "lonely pfp"
  ],
  lovers: [
    "couple aesthetic",
    "lovers aesthetic",
    "romantic couple",
    "matching couple pictures",
    "love aesthetic",
    "relationship aesthetic",
    "cute couple",
    "holding hands aesthetic",
    "long distance relationship aesthetic",
    "soft love aesthetic"
  ],
  movies: [
    "movie recommendations aesthetic",
    "romance movie aesthetic",
    "sad movie aesthetic",
    "comfort movie aesthetic",
    "underrated movies",
    "classic movies aesthetic",
    "movie poster aesthetic",
    "movie night aesthetic"
  ],
  moods: [
    "sad aesthetic",
    "lonely aesthetic",
    "healing aesthetic",
    "motivation aesthetic",
    "midnight thoughts",
    "love quotes aesthetic",
    "heartbreak aesthetic",
    "soft girl aesthetic",
    "dreamy aesthetic",
    "nostalgic aesthetic"
  ]
};

export function allCategories() {
  return Object.keys(QUERY_GROUPS);
}

export function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

export function chooseQuery(lastCategory = null, lastQuery = null) {
  let categories = allCategories();

  if (lastCategory && categories.length > 1) {
    categories = categories.filter(c => c !== lastCategory);
  }

  const category = randomItem(categories);
  let queries = QUERY_GROUPS[category];

  if (lastQuery && queries.length > 1) {
    queries = queries.filter(q => q !== lastQuery);
  }

  return { category, query: randomItem(queries) };
}
