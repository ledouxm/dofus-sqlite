import axios from "axios";
import { createWriteStream } from "fs";
import fs from "fs/promises";
import path from "path";
import { pipeline } from "stream/promises";

export interface GithubRelease {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string;
  assets: { name: string; url: string; size: number }[];
}

export const githubHeaders = () => ({
  Accept: "application/vnd.github+json",
  ...(process.env.GH_TOKEN || process.env.GITHUB_TOKEN
    ? { Authorization: `Bearer ${process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN}` }
    : {}),
});

export async function fetchReleases(repo: string) {
  const releases: GithubRelease[] = [];
  for (let page = 1; ; page++) {
    const { data } = await axios.get<GithubRelease[]>(`https://api.github.com/repos/${repo}/releases`, {
      headers: githubHeaders(),
      params: { per_page: 100, page },
    });
    releases.push(...data);
    if (data.length < 100) return releases;
  }
}

/** Published releases holding `assetName`, newest first */
export const publishedReleases = (releases: GithubRelease[], assetName = "dofus.sqlite") =>
  releases
    .filter((r) => !r.draft && !r.prerelease && r.assets.some((asset) => asset.name === assetName))
    .sort((a, b) => b.published_at.localeCompare(a.published_at));

/** The two releases to compare: the given tags, or the latest release and the one published before it */
export async function resolveReleases(repo: string, oldTag?: string, newTag?: string) {
  const releases = await fetchReleases(repo);
  const find = (tag: string) => {
    const release = releases.find((r) => r.tag_name === tag);
    if (!release) throw new Error(`Release ${tag} not found in ${repo}`);
    return release;
  };
  const published = publishedReleases(releases);

  const newRelease = newTag ? find(newTag) : published[0];
  if (!newRelease) throw new Error("No published release found");
  const oldRelease = oldTag
    ? find(oldTag)
    : published.find((r) => r.published_at < newRelease.published_at && r.tag_name !== newRelease.tag_name);
  if (!oldRelease) throw new Error(`No release found before ${newRelease.tag_name}`);

  return { oldRelease, newRelease };
}

/** Downloads a release asset into `<cacheDir>/<tag>/<name>`, or reuses the cached file */
export async function downloadAsset(release: GithubRelease, name: string, cacheDir: string) {
  const file = path.join(cacheDir, release.tag_name, name);
  if (await fs.stat(file).catch(() => null)) return file;

  const asset = release.assets.find((a) => a.name === name);
  if (!asset) throw new Error(`Release ${release.tag_name} has no ${name}`);

  console.log(`Downloading ${release.tag_name}/${name} (${(asset.size / 1e6).toFixed(1)} MB)`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const response = await axios.get(asset.url, {
    headers: { ...githubHeaders(), Accept: "application/octet-stream" },
    responseType: "stream",
  });

  // Download to a temporary name so an interrupted download is never mistaken for a cached one
  await pipeline(response.data, createWriteStream(`${file}.part`));
  await fs.rename(`${file}.part`, file);
  return file;
}
