import { App } from "@slack/bolt";
import topThousandWords from "./topThousandEnglishWords.json";

type Rule = {
  id: string,
  name: string,
  description: string,
  check: (message: string, app: App) => boolean | Promise<boolean>,
  conflictsWith?: string[],
  difficulty: number
};

const activeRules: Set<string> = new Set();

const rules: Rule[] = [{
  id: "all-lowercase",
  name: "Lowercase messages",
  description: "all messages must be in lowercase. stay calm.",
  check: (message: string) => message === message.toLowerCase(),
  difficulty: 1
}, {
  id: "all-uppercase",
  name: "Uppercase messages",
  description: "ALL MESSAGES MUST BE IN UPPERCASE. SHOUTING IS ENCOURAGED!",
  check: (message: string) => message === message.toUpperCase(),
  difficulty: 1
}, {
  id: "only-emojis",
  name: "Only emojis",
  description: ":rocket: :100: :fire:",
  check: (message: string) => message.split(" ").every(word => word.startsWith(":") && word.endsWith(":")), // TODO: This isn't a proper check
  difficulty: 2
}, {
  id: "unique-messages",
  name: "Unique messages",
  description: "Be original! No messages should be returned by a search in this workspace.",
  check: async (message: string, app: App) => {
    const result = await app.client.search.messages({
      query: message,
      token: process.env.SLACK_USER_TOKEN,
      count: 1
    });
    return (result.messages?.total ?? 0) === 0;
  },
  difficulty: 5
}, {
  id: "no-common-words",
  name: "No common words",
  description: "Cultivate novelty! Messages exclude English's 1000 commonest vocables.",
  check: (message: string) => {
    const words = message.split(/[\s\-.,!?]+/);
    return words.every(word => !topThousandWords.includes(word.toLowerCase()));
  },
  difficulty: 4
}, {
  id: "never-repeats-letters",
  name: "Never repeats letters",
  description: "No letter should be repeated in a message.",
  check: (message: string) => {
    const letters = message.toLowerCase().split("").filter(char => char.match(/[a-z]/i));
    return new Set(letters).size === letters.length;
  },
  difficulty: 5
}, {
  id: "every-letter",
  name: "Every letter",
  description: "Every letter in the English alphabet should appear at least once in a message.",
  check: (message: string) => {
    const letters = message.toLowerCase().split("").filter(char => char.match(/[a-z]/i));
    return new Set(letters).size === 26;
  },
  difficulty: 4
}, {
  id: "no-spaces",
  name: "No spaces",
  description: "Messages should not contain any spaces.",
  check: (message: string) => !message.includes(" "),
  difficulty: 3,
}, {
  id: "no-punctuation",
  name: "No punctuation",
  description: "Messages should not contain any punctuation.",
  check: (message: string) => !message.match(/[.,!?:;]/),
  difficulty: 2
}];

const conflicts: [string, string][] = [
  ["all-lowercase", "all-uppercase"],
  ["only-emojis", "all-lowercase"],
  ["only-emojis", "all-uppercase"],
  ["only-emojis", "no-common-words"],
  ["only-emojis", "never-repeats-letters"],
  ["only-emojis", "every-letter"],
  ["only-emojis", "no-spaces"],
  ["only-emojis", "no-punctuation"],
  ["never-repeats-letters", "every-letter"],
  ["no-common-words", "no-spaces"]
];
conflicts.forEach(([rule1ID, rule2ID]) => {
  const rule1 = rules.find(rule => rule.id === rule1ID);
  const rule2 = rules.find(rule => rule.id === rule2ID);
  if(!rule1 || !rule2) {
    console.error(`Rule with ID ${rule1ID} or ${rule2ID} not found when resolving conflicts.`);
    return;
  }

  rule1.conflictsWith ??= [];
  rule1.conflictsWith.push(rule2ID);
  rule2.conflictsWith ??= [];
  rule2.conflictsWith.push(rule1ID);
});


// Rule adjustment

let violationHistoryForThisRuleset: { violations: Rule[] }[] = [];
let lastRulesetChange = Date.now();
function getFailRatio(): number {
  const messagesViolatingRules = violationHistoryForThisRuleset.filter(ruleset => ruleset.violations.length > 0).length;
  return messagesViolatingRules / violationHistoryForThisRuleset.length;
}

const minimumTimeBetweenChanges = 1000 * 60 * 5; // 5 minutes
const maximumTimeBetweenChanges = 1000 * 60 * 60 * 5; // 5 hours
const minFailRatio = 0.1; // If less than this ratio of messages violate the rules, we increase the difficulty
const maxFailRatio = 0.5; // If more than this ratio of messages violate the rules, we decrease the difficulty
const minimumSampleSize = 10; // We need at least this many messages to make a decision
const maximumMessagesUntilChange = 100; // We will change the ruleset after this many messages, regardless of the fail ratio
const changeChance = 0.3; // The chance of changing the ruleset based on the fail ratio after the maximum number of messages has been reached
const completeChangeChance = 0.05; // The chance of the ruleset being completely replaced after the maximum number of messages has been reached
const initialRoughDifficulty = 6; // The initial rough difficulty of the ruleset
const mutationIterations = 15; // The number of times we randomly mutate the current ruleset before evaluating the change
const mutationAmount = 3; // The number of rules we randomly change in the ruleset when mutating

function isValidRuleset(ruleset: Set<string>): boolean {
  const conflicts = rules.filter(rule => ruleset.has(rule.id)).flatMap(rule => rule.conflictsWith ?? []);
  return !conflicts.some(conflict => ruleset.has(conflict));
}

/// Randomly varies a ruleset into another valid ruleset
function mutateRuleset(currentRuleset: Set<string>, amount: number): Set<string> {
  let newRuleset = new Set(currentRuleset);
  for(let i = 0; i < amount; i++) {
    let oldRuleset = new Set(newRuleset);
    do {
      newRuleset = new Set(oldRuleset);
      const ruleToChange = rules[Math.floor(Math.random() * rules.length)];
      if(newRuleset.has(ruleToChange.id)) {
        newRuleset.delete(ruleToChange.id);
      } else {
        newRuleset.add(ruleToChange.id);
      }
    } while(!isValidRuleset(newRuleset));
  }
  return newRuleset;
}

// Makes the ruleset easier by mutating and picking the closest ruleset with a lower difficulty
function makeEasierRuleset(currentRuleset: Set<string>): {
  success: boolean,
  ruleset: Set<string>
} {
  const mutatedRulesets = Array.from({ length: mutationIterations }, () => mutateRuleset(currentRuleset, mutationAmount));
  // Pick the ruleset with the closest difficulty lower than the current one, and return the current ruleset if none are found
  const closestRuleset = mutatedRulesets
    .filter(ruleset => calculateDifficulty(ruleset) < calculateDifficulty(currentRuleset))
    .sort((a, b) => calculateDifficulty(currentRuleset) - calculateDifficulty(a))
    .pop();
  if(!closestRuleset) return { success: false, ruleset: currentRuleset };
  return { success: true, ruleset: closestRuleset };
}

// Makes the ruleset harder by mutating and picking the closest ruleset with a higher difficulty
function makeHarderRuleset(currentRuleset: Set<string>): {
  success: boolean,
  ruleset: Set<string>
} {
  const mutatedRulesets = Array.from({ length: mutationIterations }, () => mutateRuleset(currentRuleset, mutationAmount));
  // Pick the ruleset with the closest difficulty higher than the current one, and return the current ruleset if none are found
  const closestRuleset = mutatedRulesets
    .filter(ruleset => calculateDifficulty(ruleset) > calculateDifficulty(currentRuleset))
    .sort((a, b) => calculateDifficulty(a) - calculateDifficulty(currentRuleset))
    .pop();
  if(!closestRuleset) return { success: false, ruleset: currentRuleset };
  return { success: true, ruleset: closestRuleset };
}

// Gets all the rules that can be added to the current ruleset without violating any conflicts
function getAdditionalValidRules(currentRuleset: Set<string>): Set<string> {
  const validRules = new Set(
    rules
      .filter(rule => !currentRuleset.has(rule.id) && isValidRuleset(new Set([...currentRuleset, rule.id])))
      .map(rule => rule.id)
  );
  return validRules;
}

// Calculates the difficulty of a ruleset
function calculateDifficulty(ruleset: Set<string>): number {
  return Array.from(ruleset).map(id => rules.find(rule => rule.id === id)!.difficulty).reduce((acc, val) => (acc ?? 0) + val, 0);
}

// Generates a random valid ruleset with a rough difficulty
function randomValidRuleset(roughDifficulty: number, attempt = 0): Set<string> {
  let ruleset = new Set<string>();
  while(calculateDifficulty(ruleset) < roughDifficulty) {
    const validRules = getAdditionalValidRules(ruleset);
    if(validRules.size === 0) break;
    const ruleToAdd = Array.from(validRules)[Math.floor(Math.random() * validRules.size)];
    ruleset.add(ruleToAdd);
  }
  if(ruleset.size === 0 && attempt < 10) {
    console.error("Couldn't generate a valid ruleset for some reason. Trying again.");
    return randomValidRuleset(roughDifficulty, attempt + 1);
  }
  return ruleset;
}

async function updateRules(newRuleset: Set<string>, reason: string, app: App): Promise<void> {
  newRuleset = new Set(newRuleset); // If newRuleset is activeRules, it would be a reference to the same object, which would cause issues
  activeRules.clear();
  newRuleset.forEach(rule => activeRules.add(rule));
  violationHistoryForThisRuleset = [];
  lastRulesetChange = Date.now();

  console.log('\x1b[33m', `Ruleset updated: ${reason}`, '\x1b[0m');
  console.log('\x1b[33m', `New ruleset: ${Array.from(activeRules).join(", ")}`, '\x1b[0m');

  if(!process.env.CHANNEL_ID) {
    console.error("CHANNEL_ID not set in environment variables.");
    return;
  }

  if(process.env.QUIET === "full") return;
  
  const rulesMessage = getRulesMessage();
  const message = `${reason}\n\n${rulesMessage}`;
  if(process.env.QUIET === undefined) app.client.chat.postMessage({
    channel: process.env.CHANNEL_ID,
    text: message
  });

  const channelInfo = await app.client.conversations.info({
    channel: process.env.CHANNEL_ID
  });
  if(channelInfo.ok !== true) {
    console.error("Couldn't get channel info.");
    return;
  }

  if(channelInfo?.channel?.["properties"] === undefined) {
    console.error("Channel properties not found.");
    return;
  }

  const canvasData: {
    file_id?: string,
    is_empty?: boolean,
    quip_thread_id?: string,
  } | undefined = channelInfo.channel["properties"]["canvas"];

  const content = {
    type: "markdown",
    markdown: `> ${rulesMessage.split("\n").map(line => line.trim()).join("  \n> ")}`
  } as const;
  
  if(canvasData === undefined) {
    console.log("\x1b[33m", "No channel canvas is present; creating a new one.", "\x1b[0m");
    await app.client.conversations.canvases.create({
      channel_id: process.env.CHANNEL_ID,
      document_content: content
    });

    console.log("\x1b[33m", "Canvas created.", "\x1b[0m");
  } else {
    const canvas = canvasData.file_id;
    if(canvas === undefined) {
      console.error("Canvas file ID not found.");
      return;
    }

    console.log("\x1b[33m", `Channel canvas with ID ${canvas} is present; updating it.`, "\x1b[0m");

    const sections = await app.client.canvases.sections.lookup({
      canvas_id: canvas,
      criteria: {
        contains_text: "rules are currently active" // TODO: This is a pretty hacky way to find the rules section
      }
    });

    if(sections.ok !== true) {
      console.error("Couldn't get canvas sections.");
      return;
    }

    const existingSectionID = sections?.sections?.[0]?.id;
    if(existingSectionID === undefined) {
      // Couldn't find the section; creating a new one
      console.log("\x1b[33m", "No section found; creating a new one.", "\x1b[0m");
      await app.client.canvases.edit({
        changes: [
          {
            operation: "insert_at_end",
            document_content: content
          }
        ],
        canvas_id: canvas
      });
      console.log("\x1b[33m", "Section created.", "\x1b[0m");
      return;
    }

    console.log("\x1b[33m", `Section found with ID ${existingSectionID}; updating it.`, "\x1b[0m");
    await app.client.canvases.edit({
      changes: [
        {
          operation: "replace",
          section_id: existingSectionID,
          document_content: content
        }
      ],
      canvas_id: canvas
    });

    console.log("\x1b[33m", "Canvas updated.", "\x1b[0m");
  }
}

// Determines if the ruleset should be changed
export function evaluateChange(app: App) {
  const timeSinceLastChange = Date.now() - lastRulesetChange;
  if(timeSinceLastChange < minimumTimeBetweenChanges) return; // We need to wait longer before making a decision
  if(timeSinceLastChange > maximumTimeBetweenChanges) {
    const newRuleset = randomValidRuleset((initialRoughDifficulty + calculateDifficulty(activeRules)) / 2);
    updateRules(newRuleset, "The ruleset has been changed entirely, since it has been a long time since it was last changed.", app);
    return;
  }

  if(violationHistoryForThisRuleset.length < minimumSampleSize) return; // We need more data to make a decision
  if(violationHistoryForThisRuleset.length > maximumMessagesUntilChange) {
    const newRuleset = randomValidRuleset((initialRoughDifficulty + calculateDifficulty(activeRules)) / 2);
    updateRules(newRuleset, "The ruleset has been changed entirely, since there have been a lot of messages since it was last changed.", app);
    return;
  }

  if(Math.random() < changeChance) {
    const failRatio = getFailRatio();
    if(failRatio > maxFailRatio) {
      const newRuleset = makeEasierRuleset(activeRules);
      if(!newRuleset.success) {
        const newRuleset = randomValidRuleset((initialRoughDifficulty + calculateDifficulty(activeRules)) / 2);
        updateRules(newRuleset, "The fail ratio is high, but the ruleset couldn't be made easier, so we're changing it entirely.", app);
        return;
      }
      
      updateRules(newRuleset.ruleset, "The ruleset has been made easier since the fail ratio is high.", app);
      return;
    } else if(failRatio < minFailRatio) {
      const newRuleset = makeHarderRuleset(activeRules);
      if(!newRuleset.success) {
        const newRuleset = randomValidRuleset((initialRoughDifficulty + calculateDifficulty(activeRules)) / 2);
        updateRules(newRuleset, "The fail ratio is low, but the ruleset couldn't be made harder, so we're changing it entirely.", app);
        return;
      }

      updateRules(newRuleset.ruleset, "The ruleset has been made harder since the fail ratio is low.", app);
      return;
    }
  }

  if(Math.random() < completeChangeChance) {
    const newRuleset = randomValidRuleset((initialRoughDifficulty + calculateDifficulty(activeRules)) / 2);
    updateRules(newRuleset, "The ruleset has been changed entirely by chance.", app);
    return;
  }

  // No change needed
}

export function addToViolationHistory(violations: Rule[]): void {
  violationHistoryForThisRuleset.push({ violations });
}

// Rule checking and other user-facing stuff

export async function getViolations(message: string, app: App): Promise<Rule[]> {
  const violationPromises: Promise<Rule | undefined>[] = rules.filter(rule => activeRules.has(rule.id)).map(rule => {
    const result = rule.check(message, app);
    if(result instanceof Promise) return result.then(result => result ? undefined : rule);
    return new Promise(resolve => resolve(result ? undefined : rule));
  });
  return (await Promise.all(violationPromises)).filter(violation => violation !== undefined);
}

export function initializeRules(app: App): void {
  updateRules(randomValidRuleset(initialRoughDifficulty), "An initial ruleset has been created.", app);
}


export function getRulesMessage(): string {
  let message = `${activeRules.size}/${rules.length} rules are currently active:\n\n`;
  rules.forEach(rule => {
    const emoji = activeRules.has(rule.id) ? ":tw_white_check_mark:" : ":tw_x:";
    message += `${emoji} ${rule.name}: ${rule.description}\n`;
  });
  const difficulty = calculateDifficulty(activeRules);
  message += `\nExpected difficulty: ${difficulty} ${":tw_star:".repeat(difficulty)}`;
  return message;
}