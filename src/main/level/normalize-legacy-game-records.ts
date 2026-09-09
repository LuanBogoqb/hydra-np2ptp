import type { Game } from "@types";

import { db } from "./level";
import { gamesSublevel } from "./sublevels";
import { levelKeys } from "./sublevels/keys";
import { GAME_RECORD_FIELDS } from "../events/leveldb/write-policy";
import { normalizeLegacyGameRecordsWithStore } from "./normalize-legacy-game-records.policy";

// Marker sublevel, same idiom as the cloud-save v2 default migration: the
// normalization runs once per install, early in boot, before the renderer
// can issue any games write.
const normalizationSublevel = db.sublevel<string, boolean>(
  levelKeys.legacyGameRecordNormalization,
  { valueEncoding: "json" }
);
const normalizationCompletedKey = "completed";

export const normalizeLegacyGameRecords = async () =>
  normalizeLegacyGameRecordsWithStore(
    {
      getCompleted: async () =>
        (await normalizationSublevel.get(normalizationCompletedKey)) === true,
      getGames: () => gamesSublevel.iterator().all(),
      commit: async (normalizedGames: [string, Game][]) => {
        const batch = db.batch();
        for (const [key, record] of normalizedGames) {
          batch.put(key, record, { sublevel: gamesSublevel });
        }
        batch.put(normalizationCompletedKey, true, {
          sublevel: normalizationSublevel,
        });
        await batch.write();
      },
    },
    GAME_RECORD_FIELDS
  );
