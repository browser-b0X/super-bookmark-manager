import { useMemo } from "react";
import { useLibrary } from "../store/library";
import { effectivePlatform } from "./platform";

export interface LibraryCounts {
  all: number;
  status: Record<string, number>;
  favorites: number;
  categories: Map<string, number>;
  platforms: Map<string, number>;
}

/** Every sidebar/filter count in one pass over the library (not one filter per row). */
export function useLibraryCounts(): LibraryCounts {
  const posts = useLibrary(s => s.posts);
  return useMemo(() => {
    const status: Record<string, number> = {};
    const categories = new Map<string, number>();
    const platforms = new Map<string, number>();
    let favorites = 0;
    for (const p of posts) {
      status[p.status] = (status[p.status] || 0) + 1;
      if (p.favorite) favorites++;
      for (const c of p.categories) categories.set(c, (categories.get(c) || 0) + 1);
      const platform = effectivePlatform(p);
      platforms.set(platform, (platforms.get(platform) || 0) + 1);
    }
    return { all: posts.length, status, favorites, categories, platforms };
  }, [posts]);
}
