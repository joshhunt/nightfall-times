import manifest from "destiny2-manifest/node";

import fs from "fs-extra";
import path from "path";
import axios from "axios";
import crypto from "crypto";

const DEBUG = true;

// This is bungie's API key lol
const API_KEY = "10E792629C2A47E19356B8A79EEFA640";
const AFTER_THE_NIGHTFALL = "319846607";

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

async function bungieFetch(url, dontCache = false) {
  const urlHash = crypto.createHash("md5").update(url).digest("hex");

  if (!dontCache) {
    const cached = await readCacheFile(urlHash);

    if (cached) {
      return cached.data;
    }
  }

  DEBUG && console.log("FETCHING", url);

  const options = {
    headers: {
      "x-api-key": API_KEY || "",
    },
  };

  const response = await axios.get(url, options);
  const data = response.data.Response;

  if (!dontCache) {
    await writeCacheFile(urlHash, { data, url });
  }

  return data;
}

async function getProfile(membershipType, membershipId) {
  return bungieFetch(
    `https://www.bungie.net/Platform/Destiny2/${membershipType}/Profile/${membershipId}/?components=Characters`
  );
}

async function getActivityHistoryForCharacter(
  membershipType,
  membershipId,
  characterId,
  page = 0,
  count = 250
) {
  const mode = "46";

  try {
    return await bungieFetch(
      `https://www.bungie.net/Platform/Destiny2/${membershipType}/Account/${membershipId}/Character/${characterId}/Stats/Activities/?mode=${mode}&page=${page}&count=${count}`,
      true
    );
  } catch {
    return {};
  }
}

async function getCachedActivityHistory(membershipId, characterId) {
  try {
    return await fs.readJson(
      path.join(
        "data",
        `__activity-history-${membershipId}-${characterId}.json`
      )
    );
  } catch (e) {
    return [];
  }
}

async function saveCachedActivityHistory(
  membershipId,
  characterId,
  activities
) {
  return await fs.writeJSON(
    path.join("data", `__activity-history-${membershipId}-${characterId}.json`),
    activities
  );
}

const activityKey = (activity) => `${activity.activityDetails.instanceId}`;

async function getCompleteActivityHistoryForCharacter(
  membershipType,
  membershipId,
  characterId
) {
  const cached = await getCachedActivityHistory(membershipId, characterId);

  let page = 0;
  let count = 100;

  let running = true;

  const seenActivities = {};

  cached.forEach((activity) => {
    seenActivities[activityKey(activity)] = true;
  });

  const allActivities = [...cached];

  while (running) {
    const activityPage = await getActivityHistoryForCharacter(
      membershipType,
      membershipId,
      characterId,
      page,
      count
    );

    page += 1;

    if (!activityPage.activities) {
      running = false;
      break;
    }

    if (activityPage.activities.length < count) {
      running = false;
    }

    let seenCounter = 0;
    activityPage.activities.forEach((activity) => {
      const key = activityKey(activity);

      if (seenActivities[key]) {
        seenCounter += 1;
      } else {
        seenActivities[key] = true;
        allActivities.push(activity);
      }
    });

    if (seenCounter > 5) {
      running = false;
    }
  }

  await saveCachedActivityHistory(membershipId, characterId, allActivities);

  return allActivities;
}

async function getCompleteActivityHistoryForProfile(
  membershipType,
  membershipId
) {
  const profile = await getProfile(membershipType, membershipId);

  const characterIds = Object.keys(profile.characters.data);

  const activities = (
    await Promise.all(
      characterIds.map((characterId) =>
        getCompleteActivityHistoryForCharacter(
          membershipType,
          membershipId,
          characterId
        )
      )
    )
  ).flatMap((v) => v);

  activities.sort((a, b) => new Date(a.period) - new Date(b.period));

  return activities;
}

const didCompleteActivity = (activity) =>
  activity.values.completionReason.basic.value == 0 &&
  activity.values.completed.basic.value == 1;

async function getTimesForProfile(membershipType, membershipId) {
  const times = (
    await getCompleteActivityHistoryForProfile(membershipType, membershipId)
  )
    .filter(didCompleteActivity)
    .filter((activity) => {
      const activityHash = activity.activityDetails.referenceId;
      const def = manifest.get("DestinyActivityDefinition", activityHash);

      return (
        !def.displayProperties.name.includes("The Ordeal") &&
        def.displayProperties.name.includes("Nightfall") &&
        def.activityLightLevel == 820 &&
        !(
          def.hash == 3856436847 ||
          def.hash == 1391780798 ||
          def.hash == 629542775
        )
      );
    })
    .reduce((acc, activity) => {
      const newAcc = { ...acc };
      const prev =
        newAcc[activity.activityDetails.referenceId] || 999999999999999;
      newAcc[activity.activityDetails.referenceId] = Math.min(
        prev,
        activity.values.activityDurationSeconds.basic.value
      );

      return newAcc;
    }, {});

  console.log("Times for", membershipType, membershipId);

  Object.entries(times).forEach(([activityHash, timeSeconds]) => {
    const activity = manifest.get("DestinyActivityDefinition", activityHash);

    console.log(
      "-",
      activityHash,
      "\t",
      activity.displayProperties.name,
      "-",
      secondsToHms(timeSeconds)
    );
  });

  return times;
}

async function main() {
  await manifest.load();

  const profilesToCheck = await fs.readJSON(
    path.join("data", "__profilesWithEmblem.json")
  );

  const data = [];

  for (const profile of profilesToCheck) {
    const times = await getTimesForProfile(
      profile.membershipType,
      profile.membershipId
    );
    data.push({ profile, times });

    await fs.writeJSON(path.join("data", "__nightfallTimes.json"), data);
  }
}

main().catch((e) => console.log(e));

function secondsToHms(d) {
  d = Number(d);
  var h = Math.floor(d / 3600);
  var m = Math.floor((d % 3600) / 60);
  var s = Math.floor((d % 3600) % 60);

  var hDisplay = h > 0 ? h + "h, " : "";
  var mDisplay = m > 0 ? m + "m, " : "";
  var sDisplay = s > 0 ? s + "s" : "";
  return hDisplay + mDisplay + sDisplay;
}
