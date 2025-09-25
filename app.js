const { App, ExpressReceiver } = require('@slack/bolt');
const csv = require('csv-parser');

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
    if (action === 'add' && args.length >= 3) {
      await handleAddUser(args[1], args[2], respond, client, command.user_id);
    } else if (action === 'remove' && args.length >= 3) {
      await handleRemoveUser(args[1], args[2], respond, client, command.user_id);
    } else if (action === 'list' && args.length >= 2) {
      await handleListUsers(args[1], respond, client);
    } else if (action === 'import') {
      await openImportModal(client, command);
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

// Open import modal for CSV upload
async function openImportModal(client, command) {
  try {
    // Get user's channels
    const channels = await client.conversations.list({
      types: 'public_channel,private_channel',
      exclude_archived: true
    });
    
    // Filter to channels the user is a member of
    const userChannels = [];
    for (const channel of channels.channels.slice(0, 100)) {
      try {
        const members = await client.conversations.members({ channel: channel.id });
        if (members.members.includes(command.user_id)) {
          userChannels.push({
            text: { type: 'plain_text', text: `#${channel.name}` },
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
        callback_id: 'csv_import_modal',
        title: { type: 'plain_text', text: 'Import Users from CSV' },
        submit: { type: 'plain_text', text: 'Next' },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Step 1:* Select the channel to import users into:'
            }
          },
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
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Step 2:* Paste your CSV data below:'
            }
          },
          {
            type: 'input',
            block_id: 'csv_input',
            element: {
              type: 'plain_text_input',
              action_id: 'csv_data',
              multiline: true,
              placeholder: {
                type: 'plain_text',
                text: 'email,name\njohn@company.com,John Smith\njane@company.com,Jane Doe'
              }
            },
            label: { type: 'plain_text', text: 'CSV Data' }
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: '💡 *Supported formats:* email, username, user_id columns. First row should be headers.'
              }
            ]
          }
        ]
      }
    });
  } catch (error) {
    console.error('Error opening import modal:', error);
  }
}

// Handle CSV import modal submission
app.view('csv_import_modal', async ({ ack, body, view, client }) => {
  await ack();
  
  try {
    const channelId = view.state.values.channel_select.selected_channel.selected_option.value;
    const csvData = view.state.values.csv_input.csv_data.value;
    
    if (!csvData || !csvData.trim()) {
      return;
    }
    
    // Parse CSV data
    const users = await parseCSVData(csvData);
    
    if (users.length === 0) {
      // Show error modal
      await client.views.open({
        trigger_id: body.trigger_id,
        view: {
          type: 'modal',
          callback_id: 'import_error',
          title: { type: 'plain_text', text: 'Import Error' },
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: '❌ No valid users found in CSV data.\n\nPlease check your format and try again.'
              }
            }
          ]
        }
      });
      return;
    }
    
    // Get channel info
    const channelInfo = await client.conversations.info({ channel: channelId });
    
    // Show confirmation modal
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'confirm_csv_import',
        title: { type: 'plain_text', text: 'Confirm Import' },
        submit: { type: 'plain_text', text: 'Import Users' },
        close: { type: 'plain_text', text: 'Cancel' },
        private_metadata: JSON.stringify({ channelId, csvData }),
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Target Channel:* #${channelInfo.channel.name}\n*Users Found:* ${users.length}`
            }
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Preview of users to import:*\n${users.slice(0, 8).map(u => `• ${u.email || u.username || u.user_id}`).join('\n')}${users.length > 8 ? `\n...and ${users.length - 8} more` : ''}`
            }
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: '⚠️ This will attempt to add all listed users to the selected channel.'
              }
            ]
          }
        ]
      }
    });
    
  } catch (error) {
    console.error('Error processing CSV modal:', error);
  }
});

// Handle import confirmation
app.view('confirm_csv_import', async ({ ack, body, view, client }) => {
  await ack();
  
  try {
    const metadata = JSON.parse(view.private_metadata);
    const { channelId, csvData } = metadata;
    
    // Process the import
    const result = await processCSVImportFromText(channelId, csvData, client);
    
    // Send results to channel
    await client.chat.postMessage({
      channel: channelId,
      text: `📊 *CSV Import Results*`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `📊 *Import Completed by <@${body.user.id}>*\n✅ Successfully added: ${result.success}\n❌ Failed: ${result.failed}\n⚠️ Already in channel: ${result.existing}`
          }
        }
      ]
    });
    
  } catch (error) {
    console.error('Error confirming import:', error);
    await client.chat.postMessage({
      channel: metadata.channelId,
      text: '❌ Import failed. Please try again or contact support.'
    });
  }
});

// Parse CSV data from text input
async function parseCSVData(csvText) {
  return new Promise((resolve) => {
    const users = [];
    const lines = csvText.trim().split('\n');
    
    if (lines.length < 2) {
      resolve([]);
      return;
    }
    
    // Get headers from first line
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    
    // Process each data line
    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map(v => v.trim());
      const row = {};
      
      headers.forEach((header, index) => {
        if (values[index]) {
          row[header] = values[index];
        }
      });
      
      const user = {
        email: row.email || row.email_address,
        username: row.username || row.user,
        user_id: row.user_id || row.userid,
        name: row.name || row.display_name
      };
      
      if (user.email || user.username || user.user_id) {
        users.push(user);
      }
    }
    
    resolve(users);
  });
}

// Process CSV import from text data
async function processCSVImportFromText(channelId, csvData, client) {
  try {
    const users = await parseCSVData(csvData);
    
    let success = 0, failed = 0, existing = 0;
    
    for (const user of users) {
      try {
        let slackUserId = null;
        
        if (user.user_id && user.user_id.match(/^U[A-Z0-9]+$/)) {
          slackUserId = user.user_id;
        } else if (user.email) {
          try {
            const userInfo = await client.users.lookupByEmail({ email: user.email });
            slackUserId = userInfo.user.id;
          } catch (e) {
            // Email lookup failed, try username
            if (user.username) {
              const usersList = await client.users.list();
              const foundUser = usersList.members.find(member => 
                member.name === user.username || member.display_name === user.username
              );
              if (foundUser) {
                slackUserId = foundUser.id;
              }
            }
          }
        } else if (user.username) {
          const usersList = await client.users.list();
          const foundUser = usersList.members.find(member => 
            member.name === user.username || member.display_name === user.username
          );
          if (foundUser) {
            slackUserId = foundUser.id;
          }
        }
        
        if (slackUserId) {
          await client.conversations.invite({ channel: channelId, users: slackUserId });
          success++;
        } else {
          failed++;
        }
        
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error) {
        if (error.data?.error === 'already_in_channel') {
          existing++;
        } else {
          failed++;
        }
      }
    }
    
    return { success, failed, existing };
    
  } catch (error) {
    console.error('Error processing CSV import:', error);
    throw error;
  }
}
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

// Start the app with error handling
(async () => {
  try {
    // Only start if we have valid-looking credentials
    if (process.env.SLACK_BOT_TOKEN && 
        process.env.SLACK_BOT_TOKEN.startsWith('xoxb-') &&
        process.env.SLACK_SIGNING_SECRET && 
        process.env.SLACK_SIGNING_SECRET.length > 10) {
      
      console.log('Starting Slack app with valid credentials...');
      await app.start(process.env.PORT || 3000);
      console.log('⚡️ Slack app is running!');
      
    } else {
      console.log('Starting app without Slack functionality (missing/invalid credentials)');
      // Start just the Express server for health checks
      receiver.app.listen(process.env.PORT || 3000, () => {
        console.log('⚡️ Health check server is running!');
      });
    }
  } catch (error) {
    console.error('Failed to start app:', error.message);
    // Still start the health check server
    receiver.app.listen(process.env.PORT || 3000, () => {
      console.log('⚡️ Health check server is running (Slack functionality disabled)!');
    });
  }
})();
