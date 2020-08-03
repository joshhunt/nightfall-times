import axios from "axios";
import asyncLib from "async";
import crypto from "crypto";
import path from "path";
import fs from "fs-extra";
import shuffle from "shuffle-array";

const DEBUG = false;

// This is bungie's API key lol
const API_KEY = "10E792629C2A47E19356B8A79EEFA640";
const AFTER_THE_NIGHTFALL = "319846607";

const pick = (u) => ({
  membershipId: u.membershipId,
  membershipType: u.membershipType,
});

const flagEnum = (state, value) => !!(state & value);
const enumerateCollectibleState = (state) => ({
  none: flagEnum(state, 0),
  notAcquired: flagEnum(state, 1),
  obscured: flagEnum(state, 2),
  invisible: flagEnum(state, 4),
  cannotAffordMaterialRequirements: flagEnum(state, 8),
  inventorySpaceUnavailable: flagEnum(state, 16),
  uniquenessViolation: flagEnum(state, 32),
  purchaseDisabled: flagEnum(state, 64),
});

async function readCacheFile(key) {
  try {
    return await fs.readJSON(path.join("data", `${key}.json`));
  } catch {
    return null;
  }
}

async function writeCacheFile(key, data) {
  await fs.writeJSON(path.join("data", `${key}.json`), data);
}

async function bungieFetch(url, authToken) {
  const urlHash = crypto.createHash("md5").update(url).digest("hex");

  const cached = await readCacheFile(urlHash);

  if (cached) {
    return cached.data;
  }

  DEBUG && console.log("FETCHING", url);

  const options = {
    headers: {
      "x-api-key": API_KEY || "",
    },
  };

  const response = await axios.get(url, options);
  const data = response.data.Response;

  await writeCacheFile(urlHash, { data, url });

  return data;
}

async function getProfile(membershipType, membershipId, components) {
  const componentsStr = components.join(",");

  return bungieFetch(
    `https://www.bungie.net/Platform/Destiny2/${membershipType}/Profile/${membershipId}/?components=${componentsStr}`
  );
}

function getActivityHistoryForCharacter(
  membershipType,
  membershipId,
  characterId
) {
  return bungieFetch(
    `https://www.bungie.net/Platform/Destiny2/${membershipType}/Account/${membershipId}/Character/${characterId}/Stats/Activities/`
  );
}

function getPgcr(pgcrId) {
  return bungieFetch(
    `https://www.bungie.net/Platform/Destiny2/Stats/PostGameCarnageReport/${pgcrId}`
  );
}

const QUEUE_CONCURRENCY = 5;
const PGCR_QUEUE_CONCURRENCY = 10;

const CHECK_PROFILE = "CHECK_PROFILE";
const CHECK_PROFILE_PRIORITY = 1;

const ACTIVITY_HISTORY = "ACTIVITY_HISTORY";
const ACTIVITY_HISTORY_PRIORITY = 2;

const PROFILES_WITH_EMBLEM = [];

const sleep = (sleepTime) =>
  new Promise((resolve) => setTimeout(() => resolve(), sleepTime));

const activityHistorySeen = [];
const checkProfileSeen = [];
const seenPgcrs = [];

async function jobCheckProfile(task) {
  const { membershipId, membershipType } = task;

  let profile;
  if (task.profile) {
    // profile already fetched (???), check if it has the emblem.
    profile = task.profile;
  } else {
    profile = await getProfile(membershipType, membershipId, [
      "Characters",
      "Collectibles",
    ]);
  }

  if (!profile.profileCollectibles.data) {
    return;
  }

  const collectible =
    profile.profileCollectibles.data.collectibles[AFTER_THE_NIGHTFALL];

  const enumeratedState = enumerateCollectibleState(collectible.state);
  const hasIt = !enumeratedState.notAcquired;

  if (hasIt) {
    PROFILES_WITH_EMBLEM.push({
      membershipId,
      membershipType,
      collectibleState: collectible.state,
      // enumeratedState,
    });

    console.log(
      `*** Found profile with emblem - ${membershipType}/${membershipId} ***`
    );
  }

  if (!activityHistorySeen.includes(membershipId)) {
    activityHistorySeen.push(membershipId);
    mainQueue.push(
      {
        job: ACTIVITY_HISTORY,
        profile,
        membershipType,
        membershipId,
      },
      ACTIVITY_HISTORY_PRIORITY
    );
  }
}

async function jobActivityHistory(task) {
  const { membershipId, membershipType } = task;

  let profile;
  if (task.profile) {
    // profile already fetched (???), check if it has the emblem.
    profile = task.profile;
  } else {
    profile = await getProfile(membershipType, membershipId, [
      "Characters",
      "Collectibles",
    ]);
  }

  const characterIds = Object.keys(profile.characters.data);

  const activities = (
    await Promise.all(
      characterIds.map((c) =>
        getActivityHistoryForCharacter(membershipType, membershipId, c)
      )
    )
  ).flatMap((v) => v.activities);

  for (const activity of activities) {
    const pgcrId = activity.activityDetails.instanceId;

    if (seenPgcrs.includes(pgcrId)) {
      continue;
    }

    pgcrQueue.push({ pgcrId });
  }
}

const workerFn = asyncLib.asyncify(async function (task) {
  DEBUG && console.log("JOB", task.job, JSON.stringify(pick(task)));

  switch (task.job) {
    case CHECK_PROFILE:
      return await jobCheckProfile(task);

    case ACTIVITY_HISTORY:
      return await jobActivityHistory(task);

    default:
      console.log("Unknown job??");
  }
});

const pgcrWorkerFn = asyncLib.asyncify(async function (task) {
  const { pgcrId } = task;

  const pgcr = await getPgcr(pgcrId);

  for (const playerEntry of pgcr.entries) {
    const userInfo = playerEntry.player.destinyUserInfo;

    if (
      !checkProfileSeen.includes(userInfo.membershipId) &&
      userInfo.membershipType !== 0
    ) {
      checkProfileSeen.push(userInfo.membershipId);
      mainQueue.push(
        {
          job: CHECK_PROFILE,
          ...pick(userInfo),
        },
        CHECK_PROFILE_PRIORITY
      );
    }
  }
});

let lastCount = 0;
function logStatus() {
  const jobCounts = {};

  jobCounts.PGCR = pgcrQueue.length();

  for (const task of mainQueue._tasks.toArray()) {
    jobCounts[task.job] = (jobCounts[task.job] || 0) + 1;
  }

  const profilesChecked = checkProfileSeen.length - jobCounts.CHECK_PROFILE;
  console.log(
    `Found ${PROFILES_WITH_EMBLEM.length} profiles with the emblem, checked ${profilesChecked} profiles. Jobs: CHECK_PROFILE: ${jobCounts.CHECK_PROFILE}, ACTIVITY_HISTORY: ${jobCounts.ACTIVITY_HISTORY}, PGCR: ${jobCounts.PGCR}`
  );

  if (PROFILES_WITH_EMBLEM.length > lastCount) {
    lastCount = PROFILES_WITH_EMBLEM.length;
    fs.writeFile(
      path.join("data", "__profilesWithEmblem.json"),
      JSON.stringify(PROFILES_WITH_EMBLEM, null, 2)
    );
  }
}

setInterval(logStatus, 1 * 1000);

const mainQueue = asyncLib.priorityQueue(workerFn, QUEUE_CONCURRENCY);

const pgcrQueue = asyncLib.queue(pgcrWorkerFn, PGCR_QUEUE_CONCURRENCY);

mainQueue.error(function (error, task) {
  console.error("ERROR on task", task);
  console.error(error);
});

pgcrQueue.error(function (error, task) {
  console.error("ERROR on PGCR", task);
  console.error(error);
});

const _ = (membershipType, membershipId) => ({ membershipType, membershipId });
async function run() {
  // console.log(profilesToFetch);
  // console.log("have", profilesToFetch.length, "profiles to fetch");

  // const seedProfiles = [
  //   _(2, "4611686018429113715"), // known has it
  //   _(3, "4611686018467205218"), // known has it
  //   _(1, "4611686018429935341"), // known has it
  //   _(2, "4611686018438475521"), // known has it
  //   _(2, "4611686018439159601"), // known has it
  //   _(2, "4611686018433647222"), // known has it
  //   _(2, "4611686018428514718"), // known has it
  //   _(2, "4611686018429477136"), // known has it
  //   _(1, "4611686018432869881"), // known has it
  //   _(3, "4611686018467305296"), // known has it
  //   _(2, "4611686018433674359"), // known has it
  //   _(2, "4611686018428819780"), // known has it
  //   _(3, "4611686018467184004"), // known has it
  //   _(1, "4611686018434505933"), // known has it
  //   _(2, "4611686018469271298"), // me!
  // ];

  const seedProfiles = await fs.readJSON(
    path.join("data", "__profilesWithEmblem.json")
  );

  shuffle(seedProfiles);

  seedProfiles.forEach((v) => {
    console.log("pushing", v);
    mainQueue.push({ job: CHECK_PROFILE, ...v }, CHECK_PROFILE_PRIORITY);
  });
}

run().catch((err) => console.error(err));
