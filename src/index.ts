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

const activeRules = new Set<string>();
// TEMPORARY: we hard-code the rule to be active
activeRules.add("every-letter");
activeRules.add("no-spaces");

function getRulesMessage(): string {
  let message = `${activeRules.size}/${rules.length} rules are currently active:\n\n`;
  rules.forEach(rule => {
    const emoji = activeRules.has(rule.id) ? ":tw_white_check_mark:" : ":tw_x:";
    message += `${emoji} ${rule.name}: ${rule.description}\n`;
  });
  const difficulty = Array.from(activeRules).map(id => rules.find(rule => rule.id === id)!.difficulty).reduce((acc, val) => (acc ?? 0) + val, 0);
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
});

(async () => {
    await app.start();

    console.log('\x1b[32m', 'App is running!', '\x1b[0m');
})();