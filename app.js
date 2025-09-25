const { App } = require('@slack/bolt');
const csv = require('csv-parser');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: false,
  port: process.env.PORT || 3000
});

// Health check endpoint
app.receiver.app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

// Slash command: /provision
app.command('/provision', async ({ command, ack, respond, client }) => {
  await ack();
  
  const args = command.text.trim().split(/\s+/);
  const action = args[0];
  
  try {
    if (action === 'add' && args.length >= 3) {
      await handleAddUser(args[1], args[2], respond, client, command.user_id);
    } else if (action === 'remove' && args.length >= 3) {
      await handleRemoveUser(args[1], args[2], respond, client, command.user_id);
    } else if (action === 'list' && args.length >= 2) {
      await handleListUsers(args[1], respond, client);
    } else if (action === 'import') {
      await respond({
        response_type: 'ephemeral',
        text: '📋 *CSV Import Instructions:*\n\n1. Upload a CSV file to any channel\n2. Click "Import Users" button\n3. Select target channel\n4. Confirm import\n\n*CSV should have: email, username, or user_id columns*'
      });
    } else {
      await respond({
        response_type: 'ephemeral',
        text: 'Usage:\n• `/provision add @user #channel`\n• `/provision remove @user #channel`\n• `/provision list #channel`\n• `/provision import` (for CSV help)'
      });
    }
  } catch (error) {
    console.error('Command error:', error);
    await respond({
      response_type: 'ephemeral',
      text: 'Error processing request. Please try again.'
    });
  }
});

// File upload detection
app.event('file_shared', async ({ event, client }) => {
  try {
    const fileInfo = await client.files.info({ file: event.file_id });
    
    if (fileInfo.file.mimetype === 'text/csv' || fileInfo.file.name.endsWith('.csv')) {
      await client.chat.postMessage({
        channel: event.channel_id,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `📋 *CSV file detected:* ${fileInfo.file.name}\nReady to import users to a channel?`
            }
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: '📥 Import Users' },
                action_id: 'start_csv_import',
                value: event.file_id,
                style: 'primary'
              }
            ]
          }
        ]
      });
    }
  } catch (error) {
    console.error('File event error:', error);
  }
});

// Button: Start CSV import
app.action('start_csv_import', async ({ ack, body, client }) => {
  await ack();
  
  try {
    const channels = await client.conversations.list({
      types: 'public_channel,private_channel',
      exclude_archived: true
    });
    
    const channelOptions = [];
    for (const channel of channels.channels.slice(0, 100)) {
      try {
        const members = await client.conversations.members({ channel: channel.id });
        if (members.members.includes(body.user.id)) {
          channelOptions.push({
            text: { type: 'plain_text', text: `#${channel.name}` },
            value: `${channel.id}:${body.actions[0].value}`
          });
        }
      } catch (e) {
        // Skip inaccessible channels
        continue;
      }
    }
    
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'csv_import_modal',
        title: { type: 'plain_text', text: 'Import Users' },
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: 'Select channel to import users into:' }
          },
          {
            type: 'section',
            accessory: {
              type: 'static_select',
              action_id: 'select_channel',
              placeholder: { type: 'plain_text', text: 'Choose channel...' },
              options: channelOptions
            },
            text: { type: 'mrkdwn', text: ' ' }
          }
        ]
      }
    });
  } catch (error) {
    console.error('Import start error:', error);
  }
});

// Channel selection
app.action('select_channel', async ({ ack, body, client }) => {
  await ack();
  
  const [channelId, fileId] = body.actions[0].selected_option.value.split(':');
  
  try {
    const fileInfo = await client.files.info({ file: fileId });
    const channelInfo = await client.conversations.info({ channel: channelId });
    
    // Download and parse CSV preview
    const csvData = await downloadFile(fileInfo.file.url_private_download);
    const users = await parseCSV(csvData);
    
    await client.views.update({
      view_id: body.view.id,
      view: {
        type: 'modal',
        callback_id: 'csv_import_modal',
        title: { type: 'plain_text', text: 'Confirm Import' },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Channel:* #${channelInfo.channel.name}\n*Users found:* ${users.length}`
            }
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Preview:*\n${users.slice(0, 5).map(u => `• ${u.email || u.username || u.user_id}`).join('\n')}${users.length > 5 ? `\n...and ${users.length - 5} more` : ''}`
            }
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: '✅ Import All' },
                action_id: 'confirm_import',
                value: `${channelId}:${fileId}`,
                style: 'primary'
              }
            ]
          }
        ]
      }
    });
  } catch (error) {
    console.error('Channel selection error:', error);
  }
});

// Confirm import
app.action('confirm_import', async ({ ack, body, client }) => {
  await ack();
  
  const [channelId, fileId] = body.actions[0].value.split(':');
  
  try {
    const result = await processCSVImport(channelId, fileId, client);
    
    await client.chat.postMessage({
      channel: channelId,
      text: `📊 *Import Complete!*\n✅ Added: ${result.success}\n❌ Failed: ${result.failed}\n⚠️ Already members: ${result.existing}`
    });
    
  } catch (error) {
    console.error('Import error:', error);
    await client.chat.postMessage({
      channel: channelId,
      text: '❌ Import failed. Please try again.'
    });
  }
});

// Helper functions
async function handleAddUser(userMention, channelMention, respond, client, requesterId) {
  const userId = extractUserId(userMention);
  const channelId = extractChannelId(channelMention);
  
  if (!userId || !channelId) {
    return respond({
      response_type: 'ephemeral',
      text: 'Please use format: `/provision add @user #channel`'
    });
  }
  
  try {
    await client.conversations.invite({ channel: channelId, users: userId });
    const userInfo = await client.users.info({ user: userId });
    const channelInfo = await client.conversations.info({ channel: channelId });
    
    respond({
      response_type: 'in_channel',
      text: `✅ Added ${userInfo.user.real_name || userInfo.user.name} to #${channelInfo.channel.name}`
    });
  } catch (error) {
    const message = error.data?.error === 'already_in_channel' 
      ? 'User is already in the channel' 
      : 'Failed to add user to channel';
    respond({ response_type: 'ephemeral', text: `❌ ${message}` });
  }
}

async function handleRemoveUser(userMention, channelMention, respond, client, requesterId) {
  const userId = extractUserId(userMention);
  const channelId = extractChannelId(channelMention);
  
  if (!userId || !channelId) {
    return respond({
      response_type: 'ephemeral',
      text: 'Please use format: `/provision remove @user #channel`'
    });
  }
  
  try {
    await client.conversations.kick({ channel: channelId, user: userId });
    const userInfo = await client.users.info({ user: userId });
    const channelInfo = await client.conversations.info({ channel: channelId });
    
    respond({
      response_type: 'in_channel',
      text: `✅ Removed ${userInfo.user.real_name || userInfo.user.name} from #${channelInfo.channel.name}`
    });
  } catch (error) {
    respond({ response_type: 'ephemeral', text: '❌ Failed to remove user from channel' });
  }
}

async function handleListUsers(channelMention, respond, client) {
  const channelId = extractChannelId(channelMention);
  
  if (!channelId) {
    return respond({
      response_type: 'ephemeral',
      text: 'Please use format: `/provision list #channel`'
    });
  }
  
  try {
    const channelInfo = await client.conversations.info({ channel: channelId });
    const members = await client.conversations.members({ channel: channelId });
    
    const userInfos = await Promise.all(
      members.members.slice(0, 50).map(id => client.users.info({ user: id }))
    );
    
    const activeUsers = userInfos
      .filter(info => !info.user.deleted && !info.user.is_bot)
      .map(info => info.user.real_name || info.user.name)
      .sort();
    
    respond({
      response_type: 'ephemeral',
      text: `*#${channelInfo.channel.name}* has ${activeUsers.length} members:\n${activeUsers.join(', ')}`
    });
  } catch (error) {
    respond({ response_type: 'ephemeral', text: '❌ Failed to list channel members' });
  }
}

function extractUserId(mention) {
  const match = mention.match(/<@([A-Z0-9]+)(\|.*)?>/);
  return match ? match[1] : null;
}

function extractChannelId(mention) {
  const match = mention.match(/<#([A-Z0-9]+)(\|.*)?>/);
  return match ? match[1] : null;
}

async function downloadFile(url) {
  const fetch = require('node-fetch');
  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` }
  });
  return response.text();
}

async function parseCSV(csvData) {
  return new Promise((resolve) => {
    const users = [];
    const { Readable } = require('stream');
    
    Readable.from([csvData])
      .pipe(csv())
      .on('data', (row) => {
        const normalizedRow = {};
        Object.keys(row).forEach(key => {
          normalizedRow[key.toLowerCase().trim()] = row[key];
        });
        
        const user = {
          email: normalizedRow.email || normalizedRow.email_address,
          username: normalizedRow.username || normalizedRow.user,
          user_id: normalizedRow.user_id || normalizedRow.userid
        };
        
        if (user.email || user.username || user.user_id) {
          users.push(user);
        }
      })
      .on('end', () => resolve(users));
  });
}

async function processCSVImport(channelId, fileId, client) {
  const fileInfo = await client.files.info({ file: fileId });
  const csvData = await downloadFile(fileInfo.file.url_private_download);
  const users = await parseCSV(csvData);
  
  let success = 0, failed = 0, existing = 0;
  
  for (const user of users) {
    try {
      let slackUserId = null;
      
      if (user.user_id) {
        slackUserId = user.user_id;
      } else if (user.email) {
        const userInfo = await client.users.lookupByEmail({ email: user.email });
        slackUserId = userInfo.user.id;
      }
      
      if (slackUserId) {
        await client.conversations.invite({ channel: channelId, users: slackUserId });
        success++;
      } else {
        failed++;
      }
      
      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 200));
      
    } catch (error) {
      if (error.data?.error === 'already_in_channel') {
        existing++;
      } else {
        failed++;
      }
    }
  }
  
  return { success, failed, existing };
}

// Start the app
(async () => {
  await app.start();
  console.log('⚡️ Slack app is running!');
})();
