// Gateway payload types from discord-api-types (maintained by the discord.js team; Discord's own
// OpenAPI spec covers REST only). Used to generate test/spec/discord-gateway.schema.json.
import type {
  GatewayIdentify, GatewayResume, GatewayHeartbeat, GatewayMessageCreateDispatchData, GatewayReadyDispatchData,
  APIMessageComponentButtonInteraction, APIChatInputApplicationCommandInteraction,
} from "discord-api-types/v10";
export type Identify = GatewayIdentify;
export type Resume = GatewayResume;
export type Heartbeat = GatewayHeartbeat;
export type MessageCreate = GatewayMessageCreateDispatchData;
export type Ready = GatewayReadyDispatchData;
export type ButtonInteraction = APIMessageComponentButtonInteraction;
export type SlashInteraction = APIChatInputApplicationCommandInteraction;
