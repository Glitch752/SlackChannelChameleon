import { App } from '@slack/bolt';

const app = new App({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  token: process.env.SLACK_BOT_TOKEN,
  clientId: process.env.SLACK_CLIENT_ID,
});

app.command('/chameleon-leaderboard', async ({ command, ack, say }) => {
  await ack();
  await say(`Hello, <@${command.user_id}>!`);
});

(async () => {
    await app.start(process.env.PORT || 3000);

    console.log("Started app");
})();