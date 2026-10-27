// Example: Custom Skill for Ghita Agent
// This demonstrates how to create a custom skill.

export interface SkillDefinition {
  name: string;
  description: string;
  version: string;
  parameters: Record<string, unknown>;
  execute: (params: Record<string, unknown>) => Promise<unknown>;
}

export const weatherSkill: SkillDefinition = {
  name: 'weather',
  description: 'Get current weather for a location',
  version: '1.0.0',
  parameters: {
    type: 'object',
    properties: {
      location: { type: 'string', description: 'City name' },
    },
    required: ['location'],
  },
  execute: async (params: Record<string, unknown>) => {
    const location = params['location'] as string;
    // In real implementation, call weather API
    return {
      location,
      temperature: 22,
      condition: 'sunny',
    };
  },
};
