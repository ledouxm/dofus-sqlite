import sqlite from "better-sqlite3";
import { execFileSync } from "child_process";
import fs from "fs/promises";
import path from "path";
import { parseArgs } from "util";
import { DOMAINS, Domain, EXTRACTORS } from "./domains";
import { FirstSeen, SCHEMA_VERSION, generate } from "./generate";
import { GithubRelease, downloadAsset, fetchReleases, publishedReleases } from "./releases";
import { GameVersion, JSON_EXPORTS, findJsonExports } from "./version";

// One-off: generates changelog.json and first-seen.json for every published release, oldest first.
//
// - Releases from before the current database layout (tables named after game files: Items, Monsters...)
//   only seed first-seen.json with the ids they contain.
// - Every later release gets a changelog against the previous one, and its cumulative first-seen.json.
//
//   pnpm changelog:backfill                 writes to changelog-backfill/<tag>/
//   pnpm changelog:backfill --upload        also uploads both files to each release (--clobber)

const { values: args } = parseArgs({
  options: {
    out: { type: "string", default: "changelog-backfill" },
    repo: { type: "string", default: "ledouxm/dofus-sqlite" },
    cache: { type: "string", default: path.join(".cache", "releases") },
    upload: { type: "boolean", default: false },
  },
});

/** Tables of the old layout holding each domain's entities */
const LEGACY_TABLES: Record<Domain, string[]> = {
  item: ["Items", "Weapons"],
  set: ["ItemSets"],
  monster: ["Monsters"],
  dungeon: ["Dungeons"],
  spell: ["Spells"],
  quest: ["Quests"],
  achievement: ["Achievements"],
  area: ["Areas"],
  subArea: ["SubAreas"],
  worldMap: ["WorldMaps"],
  hint: ["Hints"],
};

/**
 * The first releases miss most items (1,776 instead of about 19,900 from v6.0_3.0.37.25 on): starting from them
 * would date every other item to v6.0_3.0.37.25, so tracking starts with the first full release
 */
const INCOMPLETE_RELEASES = new Set(["v6.0_3.0.34.23", "v6.0_3.0.36.24"]);

const removeRelease =(release: GithubRelease) => fs.rm(path.join(args.cache!, release.tag_name), { recursive: true, force: true });

/** Marks the ids not seen yet as first seen in `tag` (null for the first release: they were there at launch) */
const markSeen = (firstSeen: FirstSeen, domain: Domain, ids: Iterable<number>, tag: string | null) => {
  const seen = (firstSeen.firstSeen[domain] ??= {});
  for (const id of ids) if (!(id in seen)) seen[id] = tag;
};

async function write(tag: string, files: Record<string, unknown>) {
  const dir = path.join(args.out!, tag);
  await fs.mkdir(dir, { recursive: true });
  const paths = await Promise.all(
    Object.entries(files).map(async ([name, content]) => {
      const file = path.join(dir, name);
      await fs.writeFile(file, JSON.stringify(content));
      return file;
    }),
  );
  if (args.upload) {
    execFileSync("gh", ["release", "upload", tag, ...paths, "--clobber", "--repo", args.repo!], { stdio: "inherit" });
  }
}

const main = async () => {
  const releases = publishedReleases(await fetchReleases(args.repo!))
    .reverse()
    .filter((release) => !INCOMPLETE_RELEASES.has(release.tag_name));
  console.log(`${releases.length} releases, from ${releases[0].tag_name} to ${releases.at(-1)!.tag_name}`);

  const firstSeen: FirstSeen = { schemaVersion: SCHEMA_VERSION, release: "", firstSeen: {} };
  let previous: { release: GithubRelease; version: GameVersion } | undefined;

  for (const [index, release] of releases.entries()) {
    const tag = release.tag_name;
    const seenAs = index === 0 ? null : tag;

    // Ids of legacy releases are kept, so a rerun does not download them again
    const legacyIdsPath = path.join(args.cache!, "legacy-ids", `${tag}.json`);
    const legacyIds = await fs.readFile(legacyIdsPath, "utf8").then((json) => JSON.parse(json) as Record<Domain, number[]>, () => undefined);
    if (legacyIds) {
      for (const domain of DOMAINS) markSeen(firstSeen, domain, legacyIds[domain] ?? [], seenAs);
      console.log(`${tag}: legacy layout, cached ids`);
      continue;
    }

    const sqlitePath = await downloadAsset(release, "dofus.sqlite", args.cache!);
    const db = new sqlite(sqlitePath, { readonly: true });
    const legacy = !db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'ItemData'`).get();

    if (legacy) {
      const ids = {} as Record<Domain, number[]>;
      for (const domain of DOMAINS) {
        ids[domain] = LEGACY_TABLES[domain]
          .filter((table) => db.prepare(`SELECT 1 FROM sqlite_master WHERE name = ?`).get(table))
          .flatMap((table) => (db.prepare(`SELECT id FROM "${table}"`).all() as { id: number }[]).map((row) => row.id));
        markSeen(firstSeen, domain, ids[domain], seenAs);
      }
      db.close();
      await fs.mkdir(path.dirname(legacyIdsPath), { recursive: true });
      await fs.writeFile(legacyIdsPath, JSON.stringify(ids));
      await removeRelease(release);
      console.log(`${tag}: legacy layout, ids recorded`);
      continue;
    }
    db.close();

    for (const name of JSON_EXPORTS) await downloadAsset(release, name, args.cache!);
    const version = new GameVersion(tag, sqlitePath, await findJsonExports(path.dirname(sqlitePath)));

    if (!previous) {
      // First release with the current layout: nothing to compare it with
      for (const domain of DOMAINS) {
        const visible = [...EXTRACTORS[domain](version)].filter(([, entity]) => !entity.hidden).map(([id]) => id);
        markSeen(firstSeen, domain, visible, seenAs);
      }
      firstSeen.release = tag;
      await write(tag, { "first-seen.json": firstSeen });
      console.log(`${tag}: first release with the current layout, first-seen.json only`);
    } else {
      console.log(`${tag}: comparing with ${previous.release.tag_name}`);
      const result = generate(previous.version, version, firstSeen);
      firstSeen.firstSeen = result.firstSeen.firstSeen;
      firstSeen.release = tag;
      await write(tag, { "changelog.json": result.changelog, "first-seen.json": result.firstSeen });
      previous.version.close();
      await removeRelease(previous.release);
    }
    previous = { release, version };
  }
  previous?.version.close();
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
