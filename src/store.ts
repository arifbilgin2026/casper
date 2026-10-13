/* Where a family's progress lives.
 *
 * One DynamoDB item per account: the parent's credentials, the child's name,
 * the language, and the stars — so a toddler's progress survives the browser
 * tab, which is the whole reason the game has accounts at all.
 *
 * With no table configured (local dev, reviewers without AWS) the same
 * interface runs in memory: every feature works, nothing survives a restart,
 * and the code path difference is this file and nothing else.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

export interface User {
  email: string;
  pw: string;                   // scrypt: salthex:hashhex
  childName: string;
  lang: "tr" | "ru" | "en";
  stars: number;
  mastered: string[];           // words answered correctly at least once
  createdAt: string;
}

export interface Store {
  get(email: string): Promise<User | null>;
  create(user: User): Promise<boolean>;      // false if the email exists
  addStar(email: string, word: string): Promise<void>;
  setLang(email: string, lang: User["lang"]): Promise<void>;
}

class MemoryStore implements Store {
  private users = new Map<string, User>();
  async get(email: string) { return this.users.get(email) ?? null; }
  async create(user: User) {
    if (this.users.has(user.email)) return false;
    this.users.set(user.email, { ...user });
    return true;
  }
  async addStar(email: string, word: string) {
    const u = this.users.get(email);
    if (!u) return;
    u.stars += 1;
    if (!u.mastered.includes(word)) u.mastered.push(word);
  }
  async setLang(email: string, lang: User["lang"]) {
    const u = this.users.get(email);
    if (u) u.lang = lang;
  }
}

class DynamoStore implements Store {
  private doc: DynamoDBDocumentClient;
  constructor(private table: string, region: string) {
    this.doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  }
  async get(email: string) {
    const r = await this.doc.send(new GetCommand({
      TableName: this.table, Key: { email } }));
    return (r.Item as User | undefined) ?? null;
  }
  async create(user: User) {
    try {
      await this.doc.send(new PutCommand({
        TableName: this.table, Item: user,
        ConditionExpression: "attribute_not_exists(email)",
      }));
      return true;
    } catch (e: unknown) {
      if ((e as { name?: string }).name === "ConditionalCheckFailedException") return false;
      throw e;
    }
  }
  async addStar(email: string, word: string) {
    // ADD for the counter; the mastered list is a set so repeats are free.
    await this.doc.send(new UpdateCommand({
      TableName: this.table, Key: { email },
      UpdateExpression: "ADD stars :one SET mastered = list_append(" +
        "if_not_exists(mastered, :empty), :w)",
      ConditionExpression: "attribute_exists(email) AND NOT contains(mastered, :word)",
      ExpressionAttributeValues: { ":one": 1, ":empty": [], ":w": [word], ":word": word },
    })).catch(async (e: { name?: string }) => {
      if (e.name !== "ConditionalCheckFailedException") throw e;
      // Word already mastered: still count the star.
      await this.doc.send(new UpdateCommand({
        TableName: this.table, Key: { email },
        UpdateExpression: "ADD stars :one",
        ExpressionAttributeValues: { ":one": 1 },
      }));
    });
  }
  async setLang(email: string, lang: User["lang"]) {
    await this.doc.send(new UpdateCommand({
      TableName: this.table, Key: { email },
      UpdateExpression: "SET #l = :l",
      ExpressionAttributeNames: { "#l": "lang" },
      ExpressionAttributeValues: { ":l": lang },
    }));
  }
}

export function makeStore(): Store {
  const table = process.env.SOYLE_TABLE;
  if (!table) {
    console.log("[store] no SOYLE_TABLE — using in-memory store (local mode)");
    return new MemoryStore();
  }
  return new DynamoStore(table, process.env.AWS_REGION ?? "us-east-1");
}
