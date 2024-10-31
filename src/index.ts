import { App, LogLevel } from '@slack/bolt';
import dotenv from 'dotenv';
import { addToViolationHistory, evaluateChange, getRulesMessage, getViolations, initializeRules } from './rules';
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

initializeRules(app);

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
  
  const violations = await getViolations(message.text || "", app);
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

  addToViolationHistory(violations);
  evaluateChange(app);
});

setInterval(evaluateChange, 1000 * 60 * 5); // Check for changes every 5 minutes

(async () => {
    await app.start();

    console.log('\x1b[32m', 'App is running!', '\x1b[0m');
})();