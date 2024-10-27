import { App, LogLevel } from '@slack/bolt';
import topThousandWords from "./topThousandEnglishWords.json";
import dotenv from 'dotenv';
dotenv.config();

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  logLevel: LogLevel.DEBUG,
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
  conflictsWith?: string[]
};

const rules: Rule[] = [{
  id: "all-lowercase",
  name: "Lowercase messages",
  description: "all messages must be in lowercase. stay calm.",
  check: (message: string) => message === message.toLowerCase(),
  conflictsWith: ["all-uppercase"],
}, {
  id: "all-uppercase",
  name: "Uppercase messages",
  description: "ALL MESSAGES MUST BE IN UPPERCASE. SHOUTING IS ENCOURAGED!",
  check: (message: string) => message === message.toUpperCase(),
  conflictsWith: ["all-lowercase"],
}, {
  id: "only-emojis",
  name: "Only emojis",
  description: ":rocket: :100: :fire:",
  check: (message: string) => message.split(" ").every(word => word.startsWith(":") && word.endsWith(":")), // TODO: This isn't a proper check
}, {
  id: "unique-messages",
  name: "Unique messages",
  description: "Be original! Messages must have never been sent in this Slack workspace before.",
  check: async (message: string) => {
    const result = await app.client.search.messages({
      query: message
    });
    return (result.messages?.total ?? 0) === 0;
  }
}, {
  id: "no-common-words",
  name: "No common words",
  description: "Cultivate novelty! Messages exclude English's 1000 commonest vocables.",
  check: (message: string) => {
    const words = message.split(/[\s\-.,!?]+/);
    return words.every(word => !topThousandWords.includes(word.toLowerCase()));
  }
}];

const activeRules = new Set<string>();
// TEMPORARY: we hard-code the rule to be active
activeRules.add("unique-messages");

function getRulesMessage(): string {
  let message = `${activeRules.size}/${rules.length} rules are currently active:\n`;
  rules.forEach(rule => {
    const emoji = activeRules.has(rule.id) ? ":tw_white_check_mark:" : ":tw_x:";
    message += `${emoji} ${rule.name}: ${rule.description}\n`;
  });
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

(async () => {
    await app.start();

    console.log('\x1b[32m', 'App is running!', '\x1b[0m');
})();