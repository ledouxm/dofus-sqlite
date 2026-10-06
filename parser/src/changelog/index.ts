import fs from "fs/promises";
import path from "path";
import { parseArgs } from "util";
import { FirstSeen, generate } from "./generate";
import { GithubRelease, downloadAsset, fetchReleases, publishedReleases, resolveReleases } from "./releases";
import { GameVersion, JSON_EXPORTS, findJsonExports } from "./version";

// Generates changelog.json (what changed between two releases, per domain) and first-seen.json
// (the release each entity first appeared in) for opendofusdb.
//
//   pnpm changelog [oldTag] [newTag]                  compares two releases (default: the latest two)
//   pnpm changelog <oldTag> --new-db dofus.sqlite --new-json json/ --new-tag vX
//                                                     compares a release with local data (CI)

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", default: "changelog-out" },
    repo: { type: "string", default: "ledouxm/dofus-sqlite" },
    cache: { type: "string", default: path.join(".cache", "releases") },
    "new-db": { type: "string" },
    "new-json": { type: "string" },
    "new-tag": { type: "string" },
    // Previous first-seen.json; by default the one published with the old release, if any
    "first-seen": { type: "string" },
  },
});

const main = async () => {
  const local = args["new-db"];
  if (local && (!args["new-json"] || !args["new-tag"])) throw new Error("--new-db requires --new-json and --new-tag");

  let oldRelease: GithubRelease;
  let newRelease: GithubRelease | undefined;
  if (local) {
    // CI: the release being populated is not published yet, compare with the latest one that is
    const releases = await fetchReleases(args.repo!);
    const found = positionals[0]
      ? releases.find((r) => r.tag_name === positionals[0])
      : publishedReleases(releases).find((r) => r.tag_name !== args["new-tag"]);
    if (!found) throw new Error(`No release to compare ${args["new-tag"]} with`);
    oldRelease = found;
  } else {
    ({ oldRelease, newRelease } = await resolveReleases(args.repo!, positionals[0], positionals[1]));
  }
  const download = async (release: GithubRelease) => {
    const sqlitePath = await downloadAsset(release, "dofus.sqlite", args.cache!);
    for (const name of JSON_EXPORTS) await downloadAsset(release, name, args.cache!);
    return new GameVersion(release.tag_name, sqlitePath, await findJsonExports(path.dirname(sqlitePath)));
  };

  const oldVersion = await download(oldRelease);
  const newVersion = local ? new GameVersion(args["new-tag"]!, local, await findJsonExports(args["new-json"]!)) : await download(newRelease!);
  console.log(`Comparing ${oldVersion.tag} → ${newVersion.tag}`);

  let previousFirstSeen: FirstSeen | undefined;
  const firstSeenPath =
    args["first-seen"] ??
    (oldRelease.assets.some((asset) => asset.name === "first-seen.json") ? await downloadAsset(oldRelease, "first-seen.json", args.cache!) : undefined);
  if (firstSeenPath) previousFirstSeen = JSON.parse(await fs.readFile(firstSeenPath, "utf8"));
  else console.log("No previous first-seen.json: entities of the old release are marked as already there");

  const { changelog, firstSeen } = generate(oldVersion, newVersion, previousFirstSeen);
  oldVersion.close();
  newVersion.close();

  await fs.mkdir(args.out!, { recursive: true });
  await fs.writeFile(path.join(args.out!, "changelog.json"), JSON.stringify(changelog));
  await fs.writeFile(path.join(args.out!, "first-seen.json"), JSON.stringify(firstSeen));
  console.log(`Written to ${args.out}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
