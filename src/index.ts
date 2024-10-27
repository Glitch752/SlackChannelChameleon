import { App, SayFn } from '@slack/bolt';
import topThousandWords from "./topThousandEnglishWords.json";

const app = new App({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  token: process.env.SLACK_BOT_TOKEN,
  clientId: process.env.SLACK_CLIENT_ID,
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

app.command('/chameleon-rules', async ({ command, ack, say }) => {
  await ack();
  await say(getRulesMessage());
});

(async () => {
    await app.start(process.env.PORT || 3000);

    console.log("Started app");
})();