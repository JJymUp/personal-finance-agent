import { ConversationPlanContextSchema } from '@maggot/contracts';
import { z } from 'zod';
export const ChatStateSchema=z.object({
  lastPlan:ConversationPlanContextSchema.optional(),
  messages:z.array(z.object({id:z.string().max(80),role:z.enum(['user','assistant']),text:z.string().max(6000),
    safeText:z.string().max(1600).optional(),status:z.enum(['done','pending','error']).default('done'),createdAt:z.string()}).strict()).max(100),
  amounts:z.array(z.object({id:z.string().regex(/^amount_\d+$/),cents:z.number().int().min(0).max(10_000_000_000),currency:z.enum(['CNY','USD']).optional()}).strict()).max(32),
}).strict();
export type ChatState=z.infer<typeof ChatStateSchema>;
export type ChatMessage=ChatState['messages'][number];
export const emptyChat=():ChatState=>({messages:[],amounts:[]});
