const { App, ExpressReceiver } = require('@slack/bolt');

// Create a custom receiver to add health check
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET || 'temp-secret'
});

// Add health check route to the receiver
receiver.app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    hasSlackToken: !!process.env.SLACK_BOT_TOKEN && process.env.SLACK_BOT_TOKEN !== 'xoxb-temp',
    hasSigningSecret: !!process.env.SLACK_SIGNING_SECRET && process.env.SLACK_SIGNING_SECRET !== 'temp-secret'
  });
});

// Create app with custom receiver
const app = new App({
  token: process.env.SLACK_BOT_TOKEN || 'xoxb-temp',
  receiver: receiver
});

// Slash command: /provision
app.command('/provision', async ({ command, ack, respond, client }) => {
  await ack();
  
  const args = command.text.trim().split(/\s+/);
  const action = args[0];
  
  try {
    if (action === 'csv') {
      await openFileUploadModal(client, command);
    } else if (action === 'add' && args.length >= 3) {
      await handleAddUser(args[1], args[2], respond, client, command.user_id);
    } else if (action === 'remove' && args.length >= 3) {
      await handleRemoveUser(args[1], args[2], respond, client, command.user_id);
    } else if (action === 'list' && args.length >= 2) {
      await handleListUsers(args[1], respond, client);
    } else {
      await respond({
        response_type: 'ephemeral',
        text: 'Usage:\n• `/provision add @user #channel`\n• `/provision remove @user #channel`\n• `/provision list #channel`\n• `/provision csv` (upload CSV file)'
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

// Open file upload modal for CSV files
async function openFileUploadModal(client, command) {
  try {
    // Get available channels
    const channels = await client.conversations.list({
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 100
    });
    
    const userChannels = [];
    
    for (const channel of channels.channels) {
      try {
        const members = await client.conversations.members({ channel: channel.id });
        const botUserId = (await client.auth.test()).user_id;
        
        if (members.members.includes(command.user_id) && members.members.includes(botUserId)) {
          userChannels.push({
            text: { 
              type: 'plain_text', 
              text: `${channel.is_private ? '🔒' : '#'}${channel.name}` 
            },
            value: channel.id
          });
        }
      } catch (e) {
        continue;
      }
    }
    
    await client.views.open({
      trigger_id: command.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'csv_file_upload_modal',
        title: { type: 'plain_text', text: 'Upload CSV File' },
        submit: { type: 'plain_text', text: 'Import' },
        blocks: [
          {
            type: 'input',
            block_id: 'channel_select',
            element: {
              type: 'static_select',
              action_id: 'selected_channel',
              placeholder: { type: 'plain_text', text: 'Choose a channel...' },
              options: userChannels
            },
            label: { type: 'plain_text', text: 'Target Channel' }
          },
          {
            type: 'input',
            block_id: 'file_input',
            element: {
              type: 'file_input',
              action_id: 'csv_file',
              filetypes: ['csv'],
              max_files: 1
            },
            label: { type: 'plain_text', text: 'CSV File' }
          }
        ]
      }
    });
  } catch (error) {
    console.error('Error opening file upload modal:', error);
  }
}

// Handle CSV file upload modal submission
app.view('csv_file_upload_modal', async ({ ack, body, view, client }) => {
  await ack();
  
  try {
    const channelId = view.state.values.channel_select.selected_channel.selected_option.value;
    const fileId = view.state.values.file_input.csv_file.files[0].id;
    
    // Send immediate confirmation
    await client.chat.postMessage({
      channel: channelId,
      text: 'Starting CSV import...',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `⏳ *Processing CSV file...* \nStarted by <@${body.user.id}>`
          }
        }
      ]
    });
    
    // Process in background (no await)
    processFileInBackground(channelId, fileId, body.user.id, client);
    
  } catch (error) {
    console.error('Error in CSV upload handler:', error);
  }
});

// Background processing function
async function processFileInBackground(channelId, fileId, userId, client) {
  try {
    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
    
    // Get file and download
    const fileInfo = await client.files.info({ file: fileId });
    const csvData = await downloadFile(fileInfo.file.url_private_download);
    const emails = parseCSVEmails(csvData);
    
    let success = 0, failed = 0, existing = 0;
    
    for (const email of emails) {
      try {
        const userInfo = await client.users.lookupByEmail({ email });
        await client.conversations.invite({ channel: channelId, users: userInfo.user.id });
        success++;
        await new Promise(resolve => setTimeout(resolve, 500)); // Rate limit
      } catch (error) {
        if (error.data?.error === 'already_in_channel') {
          existing++;
        } else {
          failed++;
        }
      }
    }
    
    // Send results
    await client.chat.postMessage({
      channel: channelId,
      text: `CSV import completed. Added: ${success}, Failed: ${failed}, Already in channel: ${existing}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `📊 *CSV Import Results*\n✅ Added: ${success}\n❌ Failed: ${failed}\n⚠️ Already in channel: ${existing}\n\nImported by <@${userId}>`
          }
        }
      ]
    });
    
  } catch (error) {
    console.error('Background processing error:', error);
    await client.chat.postMessage({
      channel: channelId,
      text: 'CSV import failed',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '❌ CSV import failed. Please try again.'
          }
        }
      ]
    });
  }
}

// Simple CSV email parser
function parseCSVEmails(csvData) {
  const emails = [];
  const lines = csvData.trim().split('\n');
  
  for (const line of lines) {
    const columns = line.split(',');
    const firstColumn = columns[0].trim().replace(/"/g, '');
    
    if (firstColumn.includes('@') && firstColumn.includes('.')) {
      emails.push(firstColumn.toLowerCase());
    }
  }
  
  return emails;
}

// Download file function
async function downloadFile(url) {
  const fetch = require('node-fetch');
  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` }
  });
  return response.text();
}

// Basic helper functions
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

// Start the app with error handling
(async () => {
  try {
    if (process.env.SLACK_BOT_TOKEN && 
        process.env.SLACK_BOT_TOKEN.startsWith('xoxb-') &&
        process.env.SLACK_SIGNING_SECRET && 
        process.env.SLACK_SIGNING_SECRET.length > 10) {
      
      console.log('Starting Slack app with valid credentials...');
      await app.start(process.env.PORT || 3000);
      console.log('⚡️ Slack app is running!');
      
    } else {
      console.log('Starting app without Slack functionality (missing/invalid credentials)');
      receiver.app.listen(process.env.PORT || 3000, () => {
        console.log('⚡️ Health check server is running!');
      });
    }
  } catch (error) {
    console.error('Failed to start app:', error.message);
    receiver.app.listen(process.env.PORT || 3000, () => {
      console.log('⚡️ Health check server is running (Slack functionality disabled)!');
    });
  }
})();
