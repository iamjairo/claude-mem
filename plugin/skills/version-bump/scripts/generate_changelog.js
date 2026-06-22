#!/usr/bin/env node
const fs = require('fs');

const MAX_RELEASES = process.env.MAX_RELEASES || 50;

function generate() {
  try {
    const input = fs.readFileSync(0, 'utf8');
    if (!input || input.trim() === '') {
      process.stderr.write('No input received on stdin\n');
      process.exit(1);
    }

    const releases = JSON.parse(input);
    
    // Validate that releases is an array
    if (!Array.isArray(releases)) {
      process.stderr.write('Error: Input must be a JSON array\n');
      process.exit(1);
    }

    const lines = ['# Changelog', '', 'All notable changes to this project.', ''];
    
    releases.slice(0, MAX_RELEASES).forEach(r => {
      // Use Date object for safer parsing
      const date = new Date(r.published_at).toISOString().split('T')[0];
      lines.push(`## [${r.tag_name}] - ${date}`);
      lines.push('');
      if (r.body) lines.push(r.body.trim());
      lines.push('');
    });
    
    process.stdout.write(lines.join('\n') + '\n');
  } catch (err) {
    process.stderr.write(`Error generating changelog: ${err.message}\n`);
    process.exit(1);
  }
}

generate();
