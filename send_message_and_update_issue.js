const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');

const db = new Database('/misc/projdata11/info_fil/zhfu/lin/argus/data/agentopia.db');

const AGENT_ID = 'db9e98bf-91b1-4bdd-97ea-ca56cd3c9f48';
const PROJECT_ID = 'ebf157ab-5cc9-49d2-9ff2-508652b7632c';
const ISSUE_NUMBER = 56;

try {
  // Get the issue
  const issue = db.prepare('SELECT * FROM issues WHERE project_id = ? AND number = ?').get(PROJECT_ID, ISSUE_NUMBER);

  if (!issue) {
    console.error('Issue #56 not found');
    process.exit(1);
  }

  console.log(`Found issue #${issue.number}: ${issue.title}`);
  console.log(`Current assigned_to: ${issue.assigned_to}`);
  console.log(`Current status: ${issue.status}`);

  // Update the issue: assign back to 'user' and set status to 'done'
  db.prepare(`
    UPDATE issues
    SET assigned_to = 'user',
        status = 'done',
        updated_at = datetime('now')
    WHERE id = ?
  `).run(issue.id);

  console.log('\n✓ Issue updated: assigned to user, status set to done');

  // Add a comment to the issue
  const commentId = uuidv4();
  const commentBody = `已完成学习型因子挖掘，准备了5个基于mywq.db高夏普模式的新因子，等待您批准执行因子提交命令。因子包括：learned_pattern_6d_range_vol、learned_pattern_15d_momentum_liquidity等。`;

  db.prepare(`
    INSERT INTO issue_comments (id, issue_id, author_id, body, event_type)
    VALUES (?, ?, ?, ?, 'comment')
  `).run(commentId, issue.id, AGENT_ID, commentBody);

  console.log('✓ Comment added to issue');

  // Verify the changes
  const updatedIssue = db.prepare('SELECT * FROM issues WHERE id = ?').get(issue.id);
  console.log('\nUpdated issue:');
  console.log(`  Status: ${updatedIssue.status}`);
  console.log(`  Assigned to: ${updatedIssue.assigned_to}`);
  console.log(`  Updated at: ${updatedIssue.updated_at}`);

  const comments = db.prepare('SELECT * FROM issue_comments WHERE issue_id = ? ORDER BY created_at DESC LIMIT 1').get(issue.id);
  console.log('\nLatest comment:');
  console.log(`  Author: ${comments.author_id}`);
  console.log(`  Body: ${comments.body}`);
  console.log(`  Created: ${comments.created_at}`);

  console.log('\n✓ All operations completed successfully');

} catch (error) {
  console.error('Error:', error);
  process.exit(1);
} finally {
  db.close();
}
