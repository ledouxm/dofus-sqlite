import { Entity, RefKind, Value, list, ref, refs, text } from "./model";
import { GameVersion, effectInstance, effectResolver, parseJson, unwrapArray } from "./version";

// Each domain reduces a game version to the entities opendofusdb shows, using the same filters
// (hidden item types, quest-only monsters, class spells...), as snapshots made of model values.

export const DOMAINS = [
  "item",
  "set",
  "monster",
  "dungeon",
  "spell",
  "quest",
  "achievement",
  "area",
  "subArea",
  "worldMap",
  "hint",
] as const;
export type Domain = (typeof DOMAINS)[number];

/** ItemTypeData.categoryId, as opendofusdb names them */
const ITEM_CATEGORIES = ["equipment", "consumable", "resource", "quest", "buff", "cosmetic"] as const;

/** Bits of MonsterData.m_flags */
const MonsterFlag = { boss: 1 << 2, archmonster: 1 << 3, quest: 1 << 4 };
/** MonsterSuperRaceData id of the creatures that only exist as summons */
const SUMMONS_SUPER_RACE = 28;

/** Bits of SpellLevelData.m_flags */
const SpellLevelFlag = { castInLine: 1 << 0, castInDiagonal: 1 << 1, lineOfSight: 1 << 2, freeCellRequired: 1 << 3, rangeModifiable: 1 << 6 };
/** Spell effects shown in tooltips; the others are internal */
const VISIBLE_IN_TOOLTIP = 1;

type Row = Record<string, any>;

const ids = (value: unknown): number[] => unwrapArray<number>(parseJson(value, value)).filter((id) => typeof id === "number");

/** Fields left undefined come from columns this version lacks: they are dropped, and not compared */
const entity = (v: GameVersion, nameId: unknown, meta: Record<string, unknown>, fields: Record<string, Value | undefined>, hidden?: boolean): Entity => {
  const name = v.text(nameId);
  const defined = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Record<string, Value>;
  return { name, meta, fields: { name: text(name), ...defined }, ...(hidden === undefined ? {} : { hidden }) };
};

/** `read(row[column])`, or undefined when the version has no such column */
const column = <T>(row: Row, name: string, read: (value: any) => T): T | undefined => (name in row ? read(row[name]) : undefined);

const byId = <T extends Row>(rows: T[]) => new Map(rows.map((row) => [row.id as number, row]));

const groupBy = <T extends Row>(rows: T[], key: string) => {
  const groups = new Map<number, T[]>();
  for (const row of rows) groups.set(row[key], [...(groups.get(row[key]) ?? []), row]);
  return groups;
};

/** `[[itemId, quantity], ...]` as stored in rewards (`{ values: [id, qty] }`) */
const itemQuantities = (value: unknown) =>
  unwrapArray<any>(parseJson(value, [])).map((entry) => {
    const [itemId, quantity] = unwrapArray<number>(entry?.values ?? entry);
    return { itemId: ref("item", itemId), quantity: quantity ?? 1 } as Record<string, Value>;
  });

function items(v: GameVersion) {
  const types = byId(v.all(`SELECT id, categoryId, isInEncyclopedia FROM ItemTypeData`));

  const resolveEffects = effectResolver(v.refs("itemsdata.json"));
  const effectsOf = new Map<number, Value>();
  for (const { type, data } of v.refs("itemsdata.json")) {
    if (type.class === "ItemData" || type.class === "WeaponData") effectsOf.set(data.id, v.effects(resolveEffects(data.possibleEffects)));
  }

  const recipes = new Map<number, { jobId: number; ingredients: Record<string, Value>[] }>();
  for (const { data } of v.refs("recipesdata.json")) {
    if (typeof data.resultId !== "number") continue;
    const quantities = unwrapArray<number>(data.quantities);
    recipes.set(data.resultId, {
      jobId: data.jobId,
      ingredients: unwrapArray<number>(data.ingredientIds).map((itemId, i) => ({ itemId: ref("item", itemId), quantity: quantities[i] ?? 1 })),
    });
  }

  const result = new Map<number, Entity>();
  const add = (row: Row, weapon: boolean) => {
    const type = types.get(row.typeId);
    const recipe = recipes.get(row.id);
    const fields: Record<string, Value> = {
      description: text(v.text(row.descriptionId)),
      level: row.level,
      type: ref("itemType", row.typeId),
      set: ref("set", row.itemSetId),
      conditions: row.criterions || null,
      effects: effectsOf.get(row.id) ?? v.effects([]),
      recipe: list("itemId", recipe?.ingredients ?? [], "item"),
      recipeJob: ref("job", recipe?.jobId),
    };
    if (weapon) {
      Object.assign(fields, {
        apCost: row.apCost,
        minRange: row.minRange,
        range: row.range,
        criticalHitProbability: row.criticalHitProbability,
        criticalHitBonus: row.criticalHitBonus,
        maxCastPerTurn: row.maxCastPerTurn,
        castInLine: !!row.castInLine,
        castInDiagonal: !!row.castInDiagonal,
        lineOfSight: !!row.castTestLos,
      });
    }
    result.set(
      row.id,
      entity(v, row.nameId, {
        category: ITEM_CATEGORIES[type?.categoryId] ?? "quest",
        typeId: row.typeId,
        level: row.level,
        iconId: row.iconId,
        weapon,
      }, fields, !type || type.isInEncyclopedia === 0),
    );
  };

  for (const row of v.all(`SELECT * FROM ItemData`)) add(row, false);
  for (const row of v.all(`SELECT * FROM WeaponData`)) add(row, true);
  return result;
}

function sets(v: GameVersion) {
  const resolveEffects = effectResolver(v.refs("itemsetsdata.json"));
  const bonuses = new Map<number, Record<string, Value>[]>();
  for (const { type, data } of v.refs("itemsetsdata.json")) {
    if (type.class !== "ItemSetData") continue;
    // One entry per number of pieces worn, from 1
    bonuses.set(
      data.id,
      unwrapArray<any>(data.effects)
        .map((tier, i) => ({ pieces: i + 1, effects: v.effects(resolveEffects(tier?.values)) }) as Record<string, Value>)
        .filter((tier) => (tier.effects as { lines: unknown[] }).lines.length > 0),
    );
  }
  const levels = new Map(
    v.all<{ setId: number; level: number }>(
      `SELECT itemSetId AS setId, max(level) AS level FROM (SELECT itemSetId, level FROM ItemData UNION ALL SELECT itemSetId, level FROM WeaponData) GROUP BY itemSetId`,
    ).map((row) => [row.setId, row.level]),
  );

  const result = new Map<number, Entity>();
  for (const row of v.all(`SELECT id, nameId, items, bonusIsSecret, isCosmetic FROM ItemSetData`)) {
    const pieces = ids(row.items);
    result.set(
      row.id,
      entity(v, row.nameId, { level: levels.get(row.id) ?? null, pieces: pieces.length, isCosmetic: !!row.isCosmetic }, {
        items: refs("item", pieces),
        bonuses: list("pieces", row.bonusIsSecret ? [] : (bonuses.get(row.id) ?? [])),
        bonusIsSecret: !!row.bonusIsSecret,
        isCosmetic: !!row.isCosmetic,
      }),
    );
  }
  return result;
}

const dropRate = (drop: Row) => {
  const rates = [1, 2, 3, 4, 5].map((grade) => drop[`percentDropForGrade${grade}`] ?? 0);
  return rates.every((rate) => rate === rates[0]) ? rates[0] : rates.join(" / ");
};

function monsters(v: GameVersion) {
  const races = byId(v.all(`SELECT id, superRaceId FROM MonsterRaceData`));
  const result = new Map<number, Entity>();

  for (const row of v.all(`SELECT id, nameId, gfxId, race, m_flags, grades, drops, spells, subareas FROM MonsterData`)) {
    const grades = unwrapArray<Row>(parseJson(row.grades, []));
    const hidden = (row.m_flags & MonsterFlag.quest) !== 0 || races.get(row.race)?.superRaceId === SUMMONS_SUPER_RACE || !grades.length;

    // An item can drop twice with different conditions: keep one entry per item, the first
    const drops = new Map<number, Record<string, Value>>();
    for (const drop of unwrapArray<Row>(parseJson(row.drops, []))) {
      if (drops.has(drop.objectId)) continue;
      drops.set(drop.objectId, { itemId: ref("item", drop.objectId), rate: dropRate(drop), conditions: drop.criterions || null });
    }

    const levels = grades.map((grade) => grade.level as number);
    result.set(
      row.id,
      entity(v, row.nameId, {
        race: row.race,
        levelMin: levels.length ? Math.min(...levels) : null,
        levelMax: levels.length ? Math.max(...levels) : null,
        gfxId: row.gfxId,
        boss: (row.m_flags & MonsterFlag.boss) !== 0,
        archmonster: (row.m_flags & MonsterFlag.archmonster) !== 0,
      }, {
        race: ref("monsterRace", row.race),
        boss: (row.m_flags & MonsterFlag.boss) !== 0,
        archmonster: (row.m_flags & MonsterFlag.archmonster) !== 0,
        grades: list(
          "grade",
          grades.map((grade) => ({
            grade: grade.grade,
            level: grade.level,
            lifePoints: grade.lifePoints,
            actionPoints: grade.actionPoints,
            movementPoints: grade.movementPoints,
            experience: grade.gradeXp,
            wisdom: grade.wisdom,
            apDodge: grade.paDodge,
            mpDodge: grade.pmDodge,
            neutralResistance: grade.neutralResistance,
            earthResistance: grade.earthResistance,
            fireResistance: grade.fireResistance,
            waterResistance: grade.waterResistance,
            airResistance: grade.airResistance,
          })),
        ),
        spells: refs("spell", ids(row.spells)),
        drops: list("itemId", [...drops.values()], "item"),
        subAreas: refs("subArea", ids(row.subareas)),
      }, hidden),
    );
  }
  return result;
}

function dungeons(v: GameVersion) {
  const rooms = new Map(
    v.all<{ id: number; rooms: number }>(`SELECT DungeonData_id AS id, count(*) AS rooms FROM DungeonData_mapIds_junction GROUP BY DungeonData_id`)
      .map((row) => [row.id, row.rooms]),
  );
  const result = new Map<number, Entity>();
  // Older versions have no difficulty, bosses...: those fields are not compared, and hidden is unknown
  for (const row of v.all(`SELECT * FROM DungeonData`)) {
    result.set(
      row.id,
      entity(v, row.nameId, { level: row.optimalPlayerLevel }, {
        level: row.optimalPlayerLevel,
        minLevel: column(row, "minLevel", (value) => value),
        difficulty: column(row, "difficulty", (value) => value),
        bosses: column(row, "bosses", (value) => refs("monster", ids(value))),
        rooms: rooms.get(row.id) ?? 0,
        achievements: column(row, "achievements", (value) => refs("achievement", ids(value))),
        requiredItems: column(row, "requiredObjects", (value) =>
          list(
            "itemId",
            unwrapArray<Row>(parseJson(value, [])).map((required) => ({ itemId: ref("item", required.id), quantity: required.quantity ?? 1 })),
            "item",
          )),
      }, column(row, "difficulty", (value) => value <= 0)),
    );
  }
  return result;
}

function spells(v: GameVersion) {
  // Class spells, as opendofusdb lists them
  const breedOf = new Map(
    v.all<{ spellId: number; breedId: number }>(
      `SELECT j.target_id AS spellId, v.breedId FROM SpellVariantData v JOIN SpellVariantData_spellIds_junction j ON j.SpellVariantData_id = v.id`,
    ).map((row) => [row.spellId, row.breedId]),
  );
  const levels = groupBy(v.all(`SELECT * FROM SpellLevelData ORDER BY spellId, grade`), "spellId");
  const visible = (value: unknown) =>
    v.effects(unwrapArray<Row>(parseJson(value, [])).filter((effect) => (effect.m_flags & VISIBLE_IN_TOOLTIP) !== 0).map(effectInstance));

  const result = new Map<number, Entity>();
  for (const row of v.all(`SELECT id, nameId, descriptionId, iconId FROM SpellData`)) {
    if (!breedOf.has(row.id)) continue;
    result.set(
      row.id,
      entity(v, row.nameId, { breedId: breedOf.get(row.id), iconId: row.iconId }, {
        description: text(v.text(row.descriptionId)),
        levels: list(
          "grade",
          (levels.get(row.id) ?? []).map((level) => ({
            grade: level.grade,
            level: level.minPlayerLevel,
            apCost: level.apCost,
            minRange: level.minRange,
            maxRange: level.range,
            rangeModifiable: (level.m_flags & SpellLevelFlag.rangeModifiable) !== 0,
            criticalChance: level.criticalHitProbability,
            castsPerTurn: level.maxCastPerTurn,
            castsPerTarget: level.maxCastPerTarget,
            cooldown: level.minCastInterval,
            initialCooldown: level.initialCooldown,
            lineOfSight: (level.m_flags & SpellLevelFlag.lineOfSight) !== 0,
            castInLine: (level.m_flags & SpellLevelFlag.castInLine) !== 0,
            castInDiagonal: (level.m_flags & SpellLevelFlag.castInDiagonal) !== 0,
            freeCellRequired: (level.m_flags & SpellLevelFlag.freeCellRequired) !== 0,
            effects: visible(level.effects),
            criticalEffects: level.criticalHitProbability > 0 ? visible(level.criticalEffect) : v.effects([]),
          })),
        ),
      }),
    );
  }
  return result;
}

function quests(v: GameVersion) {
  const stepIds = groupBy(v.all(`SELECT QuestData_id AS questId, target_id AS stepId FROM QuestData_stepIds_junction ORDER BY rowid`), "questId");
  const steps = byId(v.all(`SELECT id, nameId, descriptionId, optimalLevel FROM QuestStepData`));
  const objectiveCounts = new Map(
    v.all<{ id: number; count: number }>(`SELECT QuestStepData_id AS id, count(*) AS count FROM QuestStepData_objectiveIds_junction GROUP BY QuestStepData_id`)
      .map((row) => [row.id, row.count]),
  );
  const rewards = groupBy(v.all(`SELECT * FROM QuestStepRewardData ORDER BY id`), "stepId");

  const result = new Map<number, Entity>();
  for (const row of v.all(`SELECT * FROM QuestData`)) {
    const questSteps = (stepIds.get(row.id) ?? []).flatMap(({ stepId }) => {
      const step = steps.get(stepId);
      if (!step) return [];
      return [{
        id: step.id,
        name: text(v.text(step.nameId)),
        description: text(v.text(step.descriptionId)),
        level: step.optimalLevel,
        objectives: objectiveCounts.get(step.id) ?? 0,
        rewards: list(
          "id",
          (rewards.get(step.id) ?? []).map((reward) => ({
            id: reward.id,
            levelMin: reward.levelMin,
            levelMax: reward.levelMax,
            experienceRatio: reward.experienceRatio,
            kamasRatio: reward.kamasRatio,
            items: list("itemId", itemQuantities(reward.itemsReward), "item"),
            emotes: refs("emote", ids(reward.emotesReward)),
            jobs: refs("job", ids(reward.jobsReward)),
            spells: refs("spell", ids(reward.spellsReward)),
            titles: refs("title", ids(reward.titlesReward)),
          })),
        ),
      } as Record<string, Value>];
    });

    result.set(
      row.id,
      entity(v, row.nameId, { categoryId: row.categoryId, levelMin: row.levelMin, levelMax: row.levelMax }, {
        category: ref("questCategory", row.categoryId),
        levelMin: row.levelMin,
        levelMax: row.levelMax,
        repeatType: row.repeatType,
        repeatLimit: row.repeatLimit,
        isEvent: !!row.isEvent,
        isDungeonQuest: !!row.isDungeonQuest,
        conditions: row.startCriterion || null,
        steps: list("id", questSteps),
      }),
    );
  }
  return result;
}

function achievements(v: GameVersion) {
  const objectives = groupBy(v.all(`SELECT * FROM AchievementObjectiveData ORDER BY achievementId, "order", id`), "achievementId");
  const rewards = groupBy(v.all(`SELECT * FROM AchievementRewardData ORDER BY id`), "achievementId");

  const result = new Map<number, Entity>();
  for (const row of v.all(`SELECT * FROM AchievementData`)) {
    result.set(
      row.id,
      entity(v, row.nameId, { categoryId: row.categoryId, level: row.level, points: row.points, iconId: row.iconId }, {
        description: text(v.text(row.descriptionId)),
        category: ref("achievementCategory", row.categoryId),
        level: row.level,
        points: row.points,
        objectives: list(
          "id",
          (objectives.get(row.id) ?? []).map((objective) => ({
            id: objective.id,
            name: text(v.text(objective.nameId)),
            criterion: objective.criterion || null,
          })),
        ),
        rewards: list(
          "id",
          (rewards.get(row.id) ?? []).map((reward) => {
            const quantities = ids(reward.itemsQuantityReward);
            return {
              id: reward.id,
              conditions: reward.criterions || null,
              experienceRatio: reward.experienceRatio,
              kamasRatio: reward.kamasRatio,
              guildPoints: reward.guildPoints ?? 0,
              items: list("itemId", ids(reward.itemsReward).map((itemId, i) => ({ itemId: ref("item", itemId), quantity: quantities[i] ?? 1 })), "item"),
              titles: refs("title", ids(reward.titlesReward)),
              ornaments: refs("ornament", ids(reward.ornamentsReward)),
              emotes: refs("emote", ids(reward.emotesReward)),
              spells: refs("spell", ids(reward.spellsReward)),
            } as Record<string, Value>;
          }),
        ),
      }),
    );
  }
  return result;
}

function areas(v: GameVersion) {
  const result = new Map<number, Entity>();
  for (const row of v.all(`SELECT id, nameId, superAreaId, worldmapId FROM AreaData`)) {
    result.set(row.id, entity(v, row.nameId, { superAreaId: row.superAreaId }, { worldMap: ref("worldMap", row.worldmapId), superAreaId: row.superAreaId }));
  }
  return result;
}

function subAreas(v: GameVersion) {
  const maps = new Map(
    v.all<{ id: number; maps: number }>(`SELECT subAreaId AS id, count(*) AS maps FROM MapInformationData GROUP BY subAreaId`).map((row) => [row.id, row.maps]),
  );
  const result = new Map<number, Entity>();
  for (const row of v.all(`SELECT * FROM SubAreaData`)) {
    result.set(
      row.id,
      entity(v, row.nameId, { areaId: row.areaId, level: row.level }, {
        area: ref("area", row.areaId),
        level: row.level,
        maps: maps.get(row.id) ?? 0,
        monsters: refs("monster", ids(row.monsters)),
        harvestables: refs("item", ids(row.harvestables)),
        dungeon: ref("dungeon", row.dungeonId),
        zaapMapId: row.associatedZaapMapId > 0 ? row.associatedZaapMapId : null,
      }),
    );
  }
  return result;
}

function worldMaps(v: GameVersion) {
  const result = new Map<number, Entity>();
  for (const row of v.all(`SELECT * FROM WorldMapData`)) {
    result.set(
      row.id,
      entity(v, row.nameId, { visible: !!row.visibleOnMap }, { visible: !!row.visibleOnMap, width: row.totalWidth, height: row.totalHeight }),
    );
  }
  return result;
}

function hints(v: GameVersion) {
  const result = new Map<number, Entity>();
  for (const row of v.all(`SELECT * FROM HintData`)) {
    result.set(
      row.id,
      entity(v, row.nameId, { categoryId: row.categoryId, worldMapId: row.worldMapId, gfx: row.gfx }, {
        category: ref("hintCategory", row.categoryId),
        worldMap: ref("worldMap", row.worldMapId),
        subArea: ref("subArea", row.subareaId),
        mapId: row.mapId,
        x: row.x,
        y: row.y,
      }),
    );
  }
  return result;
}

export const EXTRACTORS: Record<Domain, (v: GameVersion) => Map<number, Entity>> = {
  item: items,
  set: sets,
  monster: monsters,
  dungeon: dungeons,
  spell: spells,
  quest: quests,
  achievement: achievements,
  area: areas,
  subArea: subAreas,
  worldMap: worldMaps,
  hint: hints,
};

/** Where the name of each kind of linked object is */
const NAME_SOURCES: Record<RefKind, { tables: string[]; column: string }> = {
  item: { tables: ["ItemData", "WeaponData"], column: "nameId" },
  set: { tables: ["ItemSetData"], column: "nameId" },
  monster: { tables: ["MonsterData"], column: "nameId" },
  spell: { tables: ["SpellData"], column: "nameId" },
  dungeon: { tables: ["DungeonData"], column: "nameId" },
  quest: { tables: ["QuestData"], column: "nameId" },
  achievement: { tables: ["AchievementData"], column: "nameId" },
  area: { tables: ["AreaData"], column: "nameId" },
  subArea: { tables: ["SubAreaData"], column: "nameId" },
  worldMap: { tables: ["WorldMapData"], column: "nameId" },
  itemType: { tables: ["ItemTypeData"], column: "nameId" },
  monsterRace: { tables: ["MonsterRaceData"], column: "nameId" },
  questCategory: { tables: ["QuestCategoryData"], column: "nameId" },
  achievementCategory: { tables: ["AchievementCategoryData"], column: "nameId" },
  hintCategory: { tables: ["HintCategoryData"], column: "nameId" },
  job: { tables: ["JobData"], column: "nameId" },
  title: { tables: ["TitleData"], column: "nameMaleId" },
  ornament: { tables: ["OrnamentData"], column: "nameId" },
  emote: { tables: ["EmoticonData"], column: "nameId" },
};

/** Name of a linked object in a version, empty when it does not exist there */
export function refName(v: GameVersion, kind: RefKind, id: number) {
  for (const table of NAME_SOURCES[kind].tables) {
    if (!v.hasTable(table)) continue;
    const row = v.db.prepare(`SELECT "${NAME_SOURCES[kind].column}" AS nameId FROM "${table}" WHERE id = ?`).get(id) as Row | undefined;
    if (row) return v.text(row.nameId);
  }
  return {};
}
