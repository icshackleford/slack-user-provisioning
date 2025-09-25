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
    } else if (action === 'import') {
      await respond({
        response_type: 'ephemeral',
        text: 'CSV Import Instructions: Upload CSV files with /provision csv command, or paste CSV data directly here.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*📋 CSV Import Options:*'
            }
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Option 1: Upload CSV File* 📁\nUse `/provision csv` to upload a .csv file directly\n\n*Option 2: Paste CSV Data* 📝\nClick the button below to paste CSV text'
            }
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: '📁 Upload CSV File' },
                action_id: 'open_file_upload',
                style: 'primary'
              },
              {
                type: 'button',
                text: { type: 'plain_text', text: '📝 Paste CSV Data' },
                action_id: 'open_text_import'
              }
            ]
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: '💡 *CSV Format:* Email addresses in Column A. Headers optional.\n*Example:* john@company.com, jane@company.com'
              }
            ]
          }
        ]
      });
    } else if (action === 'add' && args.length >= 3) {
      await handleAddUser(args[1], args[2], respond, client, command.user_id);
    } else if (action === 'remove' && args.length >= 3) {
      await handleRemoveUser(args[1], args[2], respond, client, command.user_id);
    } else if (action === 'list' && args.length >= 2) {
      await handleListUsers(args[1], respond, client);
    } else {
      await respond({
        response_type: 'ephemeral',
        text: 'Usage: /provision add @user #channel, /provision remove @user #channel, /provision list #channel, /provision csv (upload file), /provision import (paste data)',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*🛠️ User Provisioning Commands:*'
            }
          },
          {
            type: 'section',
            fields: [
              {
                type: 'mrkdwn',
                text: '*Individual Users:*\n• `/provision add @user #channel`\n• `/provision remove @user #channel`\n• `/provision list #channel`'
              },
              {
                type: 'mrkdwn',
                text: '*Bulk Import:*\n• `/provision csv` (upload file)\n• `/provision import` (paste data)'
              }
            ]
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: '💡 *Tip:* For private channels, add this bot to the channel first!'
              }
            ]
          }
        ]
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
    const channels = await client.conversations.list({
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200
    });
    
    const userChannels = [];
    const botNotInChannels = [];
    
    for (const channel of channels.channels) {
      try {
        const members = await client.conversations.members({ channel: channel.id });
        const botUserId = (await client.auth.test()).user_id;
        
        if (members.members.includes(command.user_id)) {
          if (members.members.includes(botUserId)) {
            userChannels.push({
              text: { 
                type: 'plain_text', 
                text: `${channel.is_private ? '🔒' : '#'}${channel.name}` 
              },
              value: channel.id
            });
          } else {
            botNotInChannels.push({
              text: { 
                type: 'plain_text', 
                text: `${channel.is_private ? '🔒' : '#'}${channel.name} (Add bot first)` 
              },
              value: `unavailable_${channel.id}`
            });
          }
        }
      } catch (e) {
        continue;
      }
    }
    
    const allChannelOptions = [...userChannels, ...botNotInChannels];
    
    await client.views.open({
      trigger_id: command.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'csv_file_upload_modal',
        title: { type: 'plain_text', text: 'CSV File Import' },
        submit: { type: 'plain_text', text: 'Import Users' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*📁 Upload CSV File for Bulk User Import*'
            }
          },
          {
            type: 'input',
            block_id: 'channel_select',
            element: {
              type: 'static_select',
              action_id: 'selected_channel',
              placeholder: { type: 'plain_text', text: 'Choose a channel...' },
              options: allChannelOptions
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
            label: { type: 'plain_text', text: 'CSV File' },
            hint: { type: 'plain_text', text: 'Upload a .csv file with email addresses in Column A' }
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: '💡 *CSV Format:* Email addresses in Column A, headers optional\n*Example:* john@company.com, jane@company.com'
              }
            ]
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
  const selectedValue = view.state.values.channel_select.selected_channel.selected_option.value;
  
  if (selectedValue.startsWith('unavailable_')) {
    await ack({
      response_action: 'errors',
      errors: {
        'channel_select': 'Bot must be added to this channel first. Go to the channel settings and add "User Provisioning Bot" to continue.'
      }
    });
    return;
  }
  
  if (!view.state.values.file_input.csv_file.files || view.state.values.file_input.csv_file.files.length === 0) {
    await ack({
      response_action: 'errors',
      errors: {
        'file_input': 'Please select a CSV file to upload.'
      }
    });
    return;
  }
  
  await ack();
  
  try {
    const channelId = selectedValue;
    const fileId = view.state.values.file_input.csv_file.files[0].id;
    
    const fileInfo = await client.files.info({ file: fileId });
    
    if (!fileInfo.file.mimetype.includes('csv') && !fileInfo.file.name.endsWith('.csv')) {
      await client.chat.postMessage({
        channel: channelId,
        text: 'Invalid file type. Please upload a CSV file.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `❌ *File Upload Error*\n\nFile: ${fileInfo.file.name}\nError: Only CSV files (.csv) are supported.\n\nRequested by <@${body.user.id}>`
            }
          }
        ]
      });
      return;
    }
    
    const channelInfo = await client.conversations.info({ channel: channelId });
    
    await client.chat.postMessage({
      channel: channelId,
      text: `Starting CSV import from ${fileInfo.file.name} to ${channelInfo.channel.name}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `📁 *Starting CSV Import*\n\n*File:* ${fileInfo.file.name}\n*Target:* ${channelInfo.channel.is_private ? '🔒' : '#'}${channelInfo.channel.name}\n*Status:* Processing...\n\n*Initiated by:* <@${body.user.id}>`
          }
        }
      ]
    });
    
    processFileInBackground(channelId, fileId, body.user.id, client, fileInfo.file.name);
    
  } catch (error) {
    console.error('Error in CSV upload handler:', error);
  }
});

// Action handlers for enhanced import options
app.action('open_file_upload', async ({ ack, body, client }) => {
  await ack();
  
  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'redirect_to_csv',
        title: { type: 'plain_text', text: 'File Upload' },
        close: { type: 'plain_text', text: 'Close' },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '📁 *To upload CSV files, please use:*\n\n`/provision csv`\n\nThis command opens the proper file upload interface with all the features and validation.'
            }
          }
        ]
      }
    });
  } catch (error) {
    console.error('Error in open_file_upload:', error);
  }
});

app.action('open_text_import', async ({ ack, body, client }) => {
  await ack();
  
  try {
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
        
        if (members.members.includes(body.user.id) && members.members.includes(botUserId)) {
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
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'text_csv_import',
        title: { type: 'plain_text', text: 'Paste CSV Data' },
        submit: { type: 'plain_text', text: 'Import Users' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'input',
            block_id: 'channel_select',
            element: {
              type: 'static_select',
              action_id: 'selected_channel',
              placeholder: { type: 'plain_text', text: 'Choose channel...' },
              options: userChannels
            },
            label: { type: 'plain_text', text: 'Target Channel' }
          },
          {
            type: 'input',
            block_id: 'csv_text',
            element: {
              type: 'plain_text_input',
              action_id: 'csv_data',
              multiline: true,
              placeholder: {
                type: 'plain_text',
                text: 'john@company.com\njane@company.com\nmike@company.com'
              }
            },
            label: { type: 'plain_text', text: 'CSV Data' }
          }
        ]
      }
    });
  } catch (error) {
    console.error('Error in open_text_import:', error);
  }
});

// Handle text CSV import
app.view('text_csv_import', async ({ ack, body, view, client }) => {
  await ack();
  
  try {
    const channelId = view.state.values.channel_select.selected_channel.selected_option.value;
    const csvText = view.state.values.csv_text.csv_data.value;
    
    if (!csvText || !csvText.trim()) {
      return;
    }
    
    await client.chat.postMessage({
      channel: channelId,
      text: 'Processing pasted CSV data...',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `📝 *Processing Pasted CSV Data*\n\nStarted by <@${body.user.id}>`
          }
        }
      ]
    });
    
    processTextCSVInBackground(channelId, csvText, body.user.id, client);
    
  } catch (error) {
    console.error('Error in text CSV import:', error);
  }
});

// Background processing function - Fixed success counting bug
async function processFileInBackground(channelId, fileId, userId, client, fileName) {
  try {
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const fileInfo = await client.files.info({ file: fileId });
    const csvData = await downloadFile(fileInfo.file.url_private_download);
    const emails = parseCSVEmails(csvData);
    
    if (emails.length === 0) {
      await client.chat.postMessage({
        channel: channelId,
        text: 'No valid email addresses found in CSV file.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `❌ *No Valid Emails Found*\n\n*File:* ${fileName}\n*Issue:* No valid email addresses found in Column A\n\nRequested by <@${userId}>`
            }
          }
        ]
      });
      return;
    }
    
    let success = 0, failed = 0, existing = 0, notFound = 0;
    
    for (const email of emails) {
      try {
        console.log(`Processing email: ${email}`);
        
        // First, lookup the user
        const userInfo = await client.users.lookupByEmail({ email });
        console.log(`Found user: ${userInfo.user.name} (${userInfo.user.id})`);
        
        try {
          // Try to add them to the channel
          await client.conversations.invite({ 
            channel: channelId, 
            users: userInfo.user.id 
          });
          
          // If we get here, they were successfully added
          success++;
          console.log(`✅ Successfully added: ${email}`);
          
        } catch (inviteError) {
          console.log(`Invite error for ${email}:`, inviteError.data?.error);
          
          if (inviteError.data?.error === 'already_in_channel') {
            existing++;
            console.log(`⚠️ Already in channel: ${email}`);
          } else {
            // Other invite errors (permissions, channel issues, etc.)
            failed++;
            console.log(`❌ Failed to invite ${email}: ${inviteError.data?.error}`);
          }
        }
        
      } catch (lookupError) {
        console.log(`Lookup error for ${email}:`, lookupError.data?.error);
        
        if (lookupError.data?.error === 'users_not_found') {
          notFound++;
          console.log(`❌ User not found in workspace: ${email}`);
        } else {
          // Other lookup errors
          failed++;
          console.log(`❌ Failed to lookup ${email}: ${lookupError.data?.error}`);
        }
      }
      
      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log(`Final counts - Success: ${success}, Existing: ${existing}, NotFound: ${notFound}, Failed: ${failed}`);
    
    await client.chat.postMessage({
      channel: channelId,
      text: `CSV import completed. Added: ${success}, Already in channel: ${existing}, Not found: ${notFound}, Failed: ${failed}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `📊 *CSV Import Completed*\n\n*File:* ${fileName}\n*Total Processed:* ${emails.length} emails\n✅ *Successfully Added:* ${success}\n⚠️ *Already in Channel:* ${existing}\n❌ *Not Found in Workspace:* ${notFound}\n❌ *Other Failures:* ${failed}\n\nImported by <@${userId}>`
          }
        }
      ]
    });
    
  } catch (error) {
    console.error('Background processing error:', error);
    await client.chat.postMessage({
      channel: channelId,
      text: 'CSV import failed due to processing error',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `❌ *CSV Import Failed*\n\n*Error:* ${error.message}\n\nRequested by <@${userId}>`
          }
        }
      ]
    });
  }
}

// Background processing for text CSV data - Fixed success counting bug
async function processTextCSVInBackground(channelId, csvText, userId, client) {
  try {
    const emails = parseCSVEmails(csvText);
    
    if (emails.length === 0) {
      await client.chat.postMessage({
        channel: channelId,
        text: 'No valid email addresses found in pasted data.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `❌ *No Valid Emails Found*\n\nRequested by <@${userId}>`
            }
          }
        ]
      });
      return;
    }
    
    let success = 0, failed = 0, existing = 0, notFound = 0;
    
    for (const email of emails) {
      try {
        console.log(`Processing pasted email: ${email}`);
        
        // First, lookup the user
        const userInfo = await client.users.lookupByEmail({ email });
        console.log(`Found user: ${userInfo.user.name} (${userInfo.user.id})`);
        
        try {
          // Try to add them to the channel
          await client.conversations.invite({ 
            channel: channelId, 
            users: userInfo.user.id 
          });
          
          // If we get here, they were successfully added
          success++;
          console.log(`✅ Successfully added via text: ${email}`);
          
        } catch (inviteError) {
          console.log(`Text invite error for ${email}:`, inviteError.data?.error);
          
          if (inviteError.data?.error === 'already_in_channel') {
            existing++;
            console.log(`⚠️ Already in channel (text): ${email}`);
          } else {
            failed++;
            console.log(`❌ Failed to invite via text ${email}: ${inviteError.data?.error}`);
          }
        }
        
      } catch (lookupError) {
        console.log(`Text lookup error for ${email}:`, lookupError.data?.error);
        
        if (lookupError.data?.error === 'users_not_found') {
          notFound++;
          console.log(`❌ User not found in workspace (text): ${email}`);
        } else {
          failed++;
          console.log(`❌ Failed to lookup via text ${email}: ${lookupError.data?.error}`);
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    
    console.log(`Text CSV final counts - Success: ${success}, Existing: ${existing}, NotFound: ${notFound}, Failed: ${failed}`);
    
    await client.chat.postMessage({
      channel: channelId,
      text: `Text CSV import completed. Added: ${success}, Already in channel: ${existing}, Not found: ${notFound}, Failed: ${failed}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `📊 *Text CSV Import Results*\n\n*Total Processed:* ${emails.length} emails\n✅ *Successfully Added:* ${success}\n⚠️ *Already in Channel:* ${existing}\n❌ *Not Found in Workspace:* ${notFound}\n❌ *Other Failures:* ${failed}\n\nImported by <@${userId}>`
          }
        }
      ]
    });
    
  } catch (error) {
    console.error('Error in text CSV background processing:', error);
    await client.chat.postMessage({
      channel: channelId,
      text: 'Text CSV import failed',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `❌ *Text Import Failed*\n\n*Error:* ${error.message}\n\nRequested by <@${userId}>`
          }
        }
      ]
    });
  }
}

// Enhanced CSV email parser
function parseCSVEmails(csvData) {
  const emails = [];
  const lines = csvData.trim().split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const columns = line.split(',').map(col => col.trim().replace(/"/g, '').replace(/'/g, ''));
    const firstColumn = columns[0];
    
    if (firstColumn.toLowerCase().includes('email') || 
        firstColumn.toLowerCase().includes('mail') ||
        firstColumn.toLowerCase() === 'user' ||
        firstColumn.toLowerCase() === 'username') {
      continue;
    }
    
    if (firstColumn && firstColumn.includes('@') && firstColumn.includes('.')) {
      const email = firstColumn.toLowerCase();
      const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
      if (emailRegex.test(email) && !emails.includes(email)) {
        emails.push(email);
      }
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
