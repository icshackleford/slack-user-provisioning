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
    // Get user's channels for text import
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
                text: 'john@company.com\njane@company.com\nmike@company.com\n\nOr with headers:\nemail,name\njohn@company.com,John Smith'
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
    
    // Send processing message
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
    
    // Process the text data (no await)
    processTextCSVInBackground(channelId, csvText, body.user.id, client);
    
  } catch (error) {
    console.error('Error in text CSV import:', error);
  }
});

// Background processing for text CSV data
async function processTextCSVInBackground(channelId, csvText, userId, client) {
  try {
    const emails = parseCSVEmails(csvText);
    console.log(`Processing ${emails.length} emails from pasted text`);
    
    if (emails.length === 0) {
      await client.chat.postMessage({
        channel: channelId,
        text: 'No valid email addresses found in pasted data.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `❌ *No Valid Emails Found*\n\nNo valid email addresses found in the pasted data.\n\nPlease ensure emails contain @ symbol and are properly formatted.\n\nRequested by <@${userId}>`
            }
          }
        ]
      });
      return;
    }
    
    let success = 0, failed = 0, existing = 0, notFound = 0;
    
    for (const email of emails) {
      try {
        const userInfo = await client.users.lookupByEmail({ email });
        await client.conversations.invite({ channel: channelId, users: userInfo.user.id });
        success++;
      } catch (error) {
        if (error.data?.error === 'already_in_channel') {
          existing++;
        } else if (error.data?.error === 'users_not_found') {
          notFound++;
        } else {
          failed++;
        }
      }
      
      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    
    // Send results
    await client.chat.postMessage({
      channel: channelId,
      text: `Text CSV import completed. Added: ${success}, Already in channel: ${existing}, Not found: ${notFound}, Failed: ${failed}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `📊 *Text CSV Import Results*\n\n*Total Processed:* ${emails.length} emails\n✅ *Added:* ${success}\n⚠️ *Already in Channel:* ${existing}\n❌ *Not Found:* ${notFound}\n❌ *Failed:* ${failed}\n\nImported by <@${userId}>`
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
            text: `❌ *Text Import Failed*\n\nThere was an error processing your pasted CSV data.\n\nRequested by <@${userId}>`
          }
        }
      ]
    });
  }
}const { App, ExpressReceiver } = require('@slack/bolt');

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

// Open file upload modal for CSV files - Enhanced with better UI
async function openFileUploadModal(client, command) {
  try {
    // Get available channels
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
    
    // Combine available channels first, then unavailable
    const allChannelOptions = [...userChannels, ...botNotInChannels];
    
    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*📁 Upload CSV File for Bulk User Import*'
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Step 1:* Select the target channel'
        }
      }
    ];
    
    if (allChannelOptions.length > 0) {
      blocks.push({
        type: 'input',
        block_id: 'channel_select',
        element: {
          type: 'static_select',
          action_id: 'selected_channel',
          placeholder: { type: 'plain_text', text: 'Choose a channel...' },
          options: allChannelOptions
        },
        label: { type: 'plain_text', text: 'Target Channel' }
      });
    } else {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '⚠️ No available channels found. Make sure you\'re a member of channels where the bot is also added.'
        }
      });
    }
    
    blocks.push(
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Step 2:* Upload your CSV file'
        }
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
        type: 'divider'
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*📋 CSV File Format:*'
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '```email,name\njohn@company.com,John Smith\njane@company.com,Jane Doe\nmike@company.com,Mike Johnson```'
        }
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: '💡 *Tips:*\n• Email addresses should be in Column A (first column)\n• Headers are optional but recommended\n• Bot must be added to private channels first\n• Large files may take longer to process'
          }
        ]
      }
    );
    
    await client.views.open({
      trigger_id: command.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'csv_file_upload_modal',
        title: { type: 'plain_text', text: 'CSV File Import' },
        submit: { type: 'plain_text', text: 'Import Users' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: blocks
      }
    });
  } catch (error) {
    console.error('Error opening file upload modal:', error);
  }
}

// Handle CSV file upload modal submission - Enhanced with validation
app.view('csv_file_upload_modal', async ({ ack, body, view, client }) => {
  const selectedValue = view.state.values.channel_select.selected_channel.selected_option.value;
  
  // Check if user selected an unavailable channel
  if (selectedValue.startsWith('unavailable_')) {
    await ack({
      response_action: 'errors',
      errors: {
        'channel_select': 'Bot must be added to this channel first. Go to the channel settings and add "User Provisioning Bot" to continue.'
      }
    });
    return;
  }
  
  // Check if file was uploaded
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
    
    // Get file info first
    const fileInfo = await client.files.info({ file: fileId });
    
    // Validate file type
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
    
    // Get channel info for better messaging
    const channelInfo = await client.conversations.info({ channel: channelId });
    
    // Send enhanced confirmation message
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
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: '⏳ This may take a few moments for large files. Results will be posted here when complete.'
            }
          ]
        }
      ]
    });
    
    // Process in background (no await)
    processFileInBackground(channelId, fileId, body.user.id, client, fileInfo.file.name);
    
  } catch (error) {
    console.error('Error in CSV upload handler:', error);
    
    // Send error message to user
    try {
      await client.chat.postMessage({
        channel: channelId || body.user.id, // Fallback to DM if channel unavailable
        text: 'CSV upload failed due to processing error.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `❌ *CSV Upload Failed*\n\nThere was an error processing your CSV file. Please check the file format and try again.\n\nRequested by <@${body.user.id}>`
            }
          }
        ]
      });
    } catch (msgError) {
      console.error('Error sending error message:', msgError);
    }
  }
});

// Background processing function - Enhanced with better feedback
async function processFileInBackground(channelId, fileId, userId, client, fileName) {
  try {
    await new Promise(resolve => setTimeout(resolve, 1000)); // Brief delay for UX
    
    console.log(`Processing CSV file: ${fileName} for user: ${userId}`);
    
    // Get file and download with better error handling
    const fileInfo = await client.files.info({ file: fileId });
    console.log(`File size: ${fileInfo.file.size} bytes`);
    
    const csvData = await downloadFile(fileInfo.file.url_private_download);
    console.log(`Downloaded ${csvData.length} characters of CSV data`);
    
    const emails = parseCSVEmails(csvData);
    console.log(`Parsed ${emails.length} email addresses from CSV`);
    
    if (emails.length === 0) {
      await client.chat.postMessage({
        channel: channelId,
        text: 'No valid email addresses found in CSV file.',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `❌ *No Valid Emails Found*\n\n*File:* ${fileName}\n*Issue:* No valid email addresses found in Column A\n\n*Please check:*\n• Email addresses are in the first column\n• Emails contain @ symbol and domain\n• File is properly formatted CSV\n\nRequested by <@${userId}>`
            }
          }
        ]
      });
      return;
    }
    
    // Send processing update for large files
    if (emails.length > 10) {
      await client.chat.postMessage({
        channel: channelId,
        text: `Processing ${emails.length} email addresses...`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `🔄 *Processing ${emails.length} Users*\n\nThis may take ${Math.ceil(emails.length / 10)} minutes for rate limiting purposes.\nResults will be posted when complete.`
            }
          }
        ]
      });
    }
    
    let success = 0, failed = 0, existing = 0, notFound = 0;
    const failedEmails = [];
    const notFoundEmails = [];
    
    // Process emails with enhanced error tracking
    for (let i = 0; i < emails.length; i++) {
      const email = emails[i];
      console.log(`Processing ${i + 1}/${emails.length}: ${email}`);
      
      try {
        const userInfo = await client.users.lookupByEmail({ email });
        await client.conversations.invite({ channel: channelId, users: userInfo.user.id });
        success++;
        console.log(`✅ Added: ${email}`);
      } catch (error) {
        if (error.data?.error === 'already_in_channel') {
          existing++;
          console.log(`⚠️ Already in channel: ${email}`);
        } else if (error.data?.error === 'users_not_found') {
          notFound++;
          notFoundEmails.push(email);
          console.log(`❌ Not found in workspace: ${email}`);
        } else {
          failed++;
          failedEmails.push(email);
          console.log(`❌ Failed to add ${email}: ${error.data?.error}`);
        }
      }
      
      // Rate limiting with progress for large batches
      if ((i + 1) % 10 === 0 && i + 1 < emails.length) {
        await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second pause every 10 users
        console.log(`Progress: ${i + 1}/${emails.length} processed`);
      } else {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    // Send comprehensive results
    const resultBlocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `📊 *CSV Import Completed*\n\n*File:* ${fileName}\n*Total Processed:* ${emails.length} emails`
        }
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*✅ Successfully Added:*\n${success} users`
          },
          {
            type: 'mrkdwn',
            text: `*⚠️ Already in Channel:*\n${existing} users`
          },
          {
            type: 'mrkdwn',
            text: `*❌ Not Found in Workspace:*\n${notFound} users`
          },
          {
            type: 'mrkdwn',
            text: `*❌ Failed to Add:*\n${failed} users`
          }
        ]
      }
    ];
    
    // Add details for failed emails if any
    if (notFoundEmails.length > 0 && notFoundEmails.length <= 5) {
      resultBlocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Not Found:* ${notFoundEmails.join(', ')}`
        }
      });
    }
    
    if (failedEmails.length > 0 && failedEmails.length <= 5) {
      resultBlocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Failed:* ${failedEmails.join(', ')}`
        }
      });
    }
    
    resultBlocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Imported by <@${userId}> • ${new Date().toLocaleString()}`
        }
      ]
    });
    
    await client.chat.postMessage({
      channel: channelId,
      text: `CSV import completed. Added: ${success}, Already in channel: ${existing}, Not found: ${notFound}, Failed: ${failed}`,
      blocks: resultBlocks
    });
    
    console.log(`CSV import completed: ${success} success, ${existing} existing, ${notFound} not found, ${failed} failed`);
    
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
            text: `❌ *CSV Import Failed*\n\n*File:* ${fileName || 'Unknown'}\n*Error:* Processing failed\n\nPlease check your CSV format and try again. Contact support if the issue persists.\n\nRequested by <@${userId}>`
          }
        }
      ]
    });
  }
}

// Enhanced CSV email parser with better validation
function parseCSVEmails(csvData) {
  const emails = [];
  const lines = csvData.trim().split('\n');
  
  console.log(`Parsing ${lines.length} lines of CSV data`);
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    // Split by comma and get first column
    const columns = line.split(',').map(col => col.trim().replace(/"/g, '').replace(/'/g, ''));
    const firstColumn = columns[0];
    
    // Skip header-like rows
    if (firstColumn.toLowerCase().includes('email') || 
        firstColumn.toLowerCase().includes('mail') ||
        firstColumn.toLowerCase() === 'user' ||
        firstColumn.toLowerCase() === 'username') {
      console.log(`Skipping header row: ${firstColumn}`);
      continue;
    }
    
    // Enhanced email validation
    if (firstColumn && firstColumn.includes('@') && firstColumn.includes('.')) {
      const email = firstColumn.toLowerCase();
      
      // More comprehensive email validation
      const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
      if (emailRegex.test(email)) {
        // Avoid duplicates
        if (!emails.includes(email)) {
          emails.push(email);
          console.log(`Added email: ${email}`);
        } else {
          console.log(`Duplicate email skipped: ${email}`);
        }
      } else {
        console.log(`Invalid email format skipped: ${firstColumn}`);
      }
    }
  }
  
  console.log(`Final email count: ${emails.length}`);
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
