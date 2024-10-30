import { App, LogLevel } from '@slack/bolt';
import topThousandWords from "./topThousandEnglishWords.json";
import dotenv from 'dotenv';
dotenv.config();

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  // logLevel: LogLevel.DEBUG,
  // signingSecret: process.env.SLACK_SIGNING_SECRET,
  // clientId: process.env.SLACK_CLIENT_ID,
  // clientSecret: process.env.SLACK_CLIENT_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

type Rule = {
  id: string,
  name: string,
  description: string,
  check: (message: string) => boolean | Promise<boolean>,
  conflictsWith?: string[],
  difficulty: number
};

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
  check: async (message: string) => {
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
const changeChance = 0.1; // The chance of changing the ruleset after the maximum number of messages has been reached
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
  console.log('\x1b[33m', `Valid rules: ${Array.from(validRules).join(", ")}`, '\x1b[0m');
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

function updateRules(newRuleset: Set<string>, reason: string) {
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

  const message = `${reason}\n\n${getRulesMessage()}`;
  app.client.chat.postMessage({
    channel: process.env.CHANNEL_ID,
    text: message
  });
}

// Determines if the ruleset should be changed
function evaluateChange() {
  const timeSinceLastChange = Date.now() - lastRulesetChange;
  if(timeSinceLastChange < minimumTimeBetweenChanges) return; // We need to wait longer before making a decision
  if(timeSinceLastChange > maximumTimeBetweenChanges) {
    const newRuleset = randomValidRuleset((initialRoughDifficulty + calculateDifficulty(activeRules)) / 2);
    updateRules(newRuleset, "The ruleset has been changed entirely, since it has been a long time since it was last changed.");
    return;
  }

  if(violationHistoryForThisRuleset.length < minimumSampleSize) return; // We need more data to make a decision
  if(violationHistoryForThisRuleset.length > maximumMessagesUntilChange) {
    const newRuleset = randomValidRuleset((initialRoughDifficulty + calculateDifficulty(activeRules)) / 2);
    updateRules(newRuleset, "The ruleset has been changed entirely, since there have been a lot of messages since it was last changed.");
    return;
  }

  const failRatio = getFailRatio();
  if(failRatio > maxFailRatio) {
    const newRuleset = makeEasierRuleset(activeRules);
    if(!newRuleset.success) {
      const newRuleset = randomValidRuleset((initialRoughDifficulty + calculateDifficulty(activeRules)) / 2);
      updateRules(newRuleset, "The fail ratio is high, but the ruleset couldn't be made easier, so we're changing it entirely.");
      return;
    }
    
    updateRules(newRuleset.ruleset, "The ruleset has been made easier since the fail ratio is high.");
    return;
  } else if(failRatio < minFailRatio) {
    const newRuleset = makeHarderRuleset(activeRules);
    if(!newRuleset.success) {
      const newRuleset = randomValidRuleset((initialRoughDifficulty + calculateDifficulty(activeRules)) / 2);
      updateRules(newRuleset, "The fail ratio is low, but the ruleset couldn't be made harder, so we're changing it entirely.");
      return;
    }

    updateRules(newRuleset.ruleset, "The ruleset has been made harder since the fail ratio is low.");
    return;
  }
  
  if(violationHistoryForThisRuleset.length > minimumSampleSize) { // Change the ruleset entirely
    if(Math.random() < changeChance) {
      const newRuleset = randomValidRuleset((initialRoughDifficulty + calculateDifficulty(activeRules)) / 2);
      updateRules(newRuleset, "The ruleset has been changed entirely by chance.");
      return;
    }
  }

  // No change needed
}

const activeRules: Set<string> = randomValidRuleset(initialRoughDifficulty);
updateRules(activeRules, "An initial ruleset has been created.");

function getRulesMessage(): string {
  let message = `${activeRules.size}/${rules.length} rules are currently active:\n\n`;
  rules.forEach(rule => {
    const emoji = activeRules.has(rule.id) ? ":tw_white_check_mark:" : ":tw_x:";
    message += `${emoji} ${rule.name}: ${rule.description}\n`;
  });
  const difficulty = calculateDifficulty(activeRules);
  message += `\nExpected difficulty: ${difficulty} ${":tw_star:".repeat(difficulty)}`;
  return message;
}

app.command('/chameleon-rules', async ({ command, ack, respond }) => {
  console.log('\x1b[33m', `Rules command recieved from ${command.user_name}!`, '\x1b[0m');

  await ack();

  await respond({
    response_type: "in_channel",
    text: getRulesMessage()
  });
});

app.message(async ({ message, say }) => {
  if(message.subtype !== undefined && message.subtype !== "thread_broadcast") return;
  if(message.channel !== process.env.CHANNEL_ID) return;

  console.log('\x1b[33m', `Message recieved from ${message.user}: ${message.text}`, '\x1b[0m');
  
  const messageText = message.text || "";
  const violationPromises: Promise<Rule | undefined>[] = rules.filter(rule => activeRules.has(rule.id)).map(rule => {
    const result = rule.check(messageText);
    if(result instanceof Promise) return result.then(result => result ? undefined : rule);
    return new Promise(resolve => resolve(result ? undefined : rule));
  });
  const violations = (await Promise.all(violationPromises)).filter(violation => violation !== undefined);

  console.log('\x1b[34m', `Violations: ${violations.map(violation => violation.name).join(", ")}`, '\x1b[0m');

  if(violations.length > 0) {
    const violationMessages = violations.map(violation => `  :x: ${violation.name}: ${violation.description}`);
    await say({
      text: `<@${message.user}>, Your message violates the following rules:\n${violationMessages.join("\n")}`,
      thread_ts: message.ts
    });
  }

  const emoji = violations.length > 0 ? "x" : "tw_white_check_mark";
  await app.client.reactions.add({
    name: emoji,
    channel: message.channel,
    timestamp: message.ts
  });

  violationHistoryForThisRuleset.push({ violations });
  evaluateChange();
});

setInterval(evaluateChange, 1000 * 60 * 5); // Check for changes every 5 minutes

(async () => {
    await app.start();

    console.log('\x1b[32m', 'App is running!', '\x1b[0m');
})();