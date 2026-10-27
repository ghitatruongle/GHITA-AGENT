import type { ReadmeOptions, ReadmeResult } from './types.js';

/**
 * Generate a README.md for a skill based on its manifest + source files.
 * Pulls description from SKILL.md frontmatter, lists tools, includes install snippet.
 */
export class ReadmeGenerator {
  generate(
    skillId: string,
    version: string,
    description: string,
    authorName: string,
    tags: string[],
    options: ReadmeOptions = { badges: true, install: true, usage: true, license: true },
  ): ReadmeResult {
    const sections: string[] = [];
    const lines: string[] = [];

    lines.push(`# ${this.titleCase(skillId)}`);
    lines.push('');

    if (options.badges) {
      lines.push(
        `![Version](https://img.shields.io/badge/version-${version}-blue) ![License](https://img.shields.io/badge/license-MIT-green) ![GHITA](https://img.shields.io/badge/ghita-skill-purple)`,
      );
      lines.push('');
    }

    lines.push(description.trim() || 'A Ghita Agent skill.');
    lines.push('');

    if (tags.length > 0) {
      lines.push(`**Tags:** ${tags.map((t) => `\`${t}\``).join(' · ')}`);
      lines.push('');
    }

    if (options.install) {
      sections.push('Installation');
      lines.push('## Installation');
      lines.push('');
      lines.push('```bash');
      lines.push(`ghita skills install @ghita/skills/${this.slug(skillId)}`);
      lines.push('```');
      lines.push('');
    }

    if (options.usage) {
      sections.push('Usage');
      lines.push('## Usage');
      lines.push('');
      lines.push('```ts');
      lines.push(`import { ${this.camel(skillId)} } from '@ghita/skills/${this.slug(skillId)}';`);
      lines.push('');
      lines.push(`await ${this.camel(skillId)}.run({ input: '...' });`);
      lines.push('```');
      lines.push('');
    }

    sections.push('Author');
    lines.push('## Author');
    lines.push('');
    lines.push(`Built by **${authorName}** for [Ghita Agent](https://github.com/ghita-ai).`);
    lines.push('');

    if (options.contributing) {
      sections.push('Contributing');
      lines.push('## Contributing');
      lines.push('');
      lines.push('PRs welcome. Please run `npm test` before submitting.');
      lines.push('');
    }

    if (options.license) {
      sections.push('License');
      lines.push('## License');
      lines.push('');
      lines.push('MIT © GHITA Corp');
      lines.push('');
    }

    return {
      content: lines.join('\n'),
      title: this.titleCase(skillId),
      sections,
    };
  }

  private titleCase(id: string): string {
    return id
      .split(/[-_.]/)
      .filter(Boolean)
      .map((w) => (w[0] ?? '').toUpperCase() + w.slice(1))
      .join(' ');
  }

  private slug(id: string): string {
    return id.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  }

  private camel(id: string): string {
    return id
      .split(/[-_.]/)
      .filter(Boolean)
      .map((w, i) => (i === 0 ? w : (w[0] ?? '').toUpperCase() + w.slice(1)))
      .join('');
  }
}
