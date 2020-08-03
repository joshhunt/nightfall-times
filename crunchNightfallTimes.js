import manifest from "destiny2-manifest/node";

import fs from "fs-extra";
import path from "path";

function secondsToHms(_d) {
  const d = Number(_d);
  var m = Math.floor(d / 60);
  var s = d - m * 60;

  var mDisplay = m > 0 ? m + "m, " : "";
  var sDisplay = s > 0 ? s + "s" : "";
  return mDisplay + sDisplay;
}

function logTimes(entries) {
  entries.forEach(([activityHash, timeSeconds]) => {
    const activity = manifest.get("DestinyActivityDefinition", activityHash);

    if (
      !activity.displayProperties.name.includes("The Ordeal") &&
      activity.displayProperties.name.includes("Nightfall") &&
      activity.activityLightLevel == 820
    ) {
      console.log(
        "-",
        activityHash,
        "\t",
        activity.displayProperties.name,
        "-",
        secondsToHms(timeSeconds)
      );
    }
  });
}

const calcTotal = (times) =>
  Object.values(times).reduce((acc, v) => acc + v, 0);

async function main() {
  await manifest.load();

  const allTimeData = await fs.readJSON(
    path.join("data", "__nightfallTimes.json")
  );

  const BIG_NUMBER = 999999999999999;
  const individualTimes = {};
  let slowstTimeData = {};
  let slowestTotal = 0;

  allTimeData.forEach((timeData) => {
    console.log("");

    const totalTime = calcTotal(timeData.times);
    slowestTotal = Math.max(slowestTotal, totalTime);

    if (slowestTotal == totalTime) {
      slowstTimeData = timeData;
    }

    const entries = Object.entries(timeData.times);

    entries.forEach(([activityHash, timeSeconds]) => {
      individualTimes[activityHash] = Math.max(
        individualTimes[activityHash] || 0,
        timeSeconds
      );
    });

    console.log(
      "\nTimes for",
      timeData.profile.membershipType,
      timeData.profile.membershipId,
      `(${entries.length} nightfalls)`
    );

    console.log("- total:", secondsToHms(totalTime));
    logTimes(entries);
  });

  console.log("");
  console.log("");
  console.log("------------------------------------");
  console.log("");

  console.log(
    "Times from single slowest player:",
    `(total: ${secondsToHms(calcTotal(slowstTimeData.times))})`
  );
  logTimes(Object.entries(slowstTimeData.times));

  console.log(
    "\nSlowest individual nightfall times:",
    `(total: ${secondsToHms(calcTotal(individualTimes))})`
  );
  logTimes(Object.entries(individualTimes));
}

main().catch((e) => console.log(e));

// entries.sort(([a], [b]) => {
//   const activityA = manifest.get("DestinyActivityDefinition", a);
//   const activityB = manifest.get("DestinyActivityDefinition", b);

//   if (activityA.displayProperties.name > activityB.displayProperties.name) {
//     return 1;
//   } else if (
//     activityA.displayProperties.name < activityB.displayProperties.name
//   ) {
//     return -1;
//   }

//   return 0;
// });
