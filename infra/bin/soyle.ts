#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { SoyleStack } from "../lib/soyle-stack.js";

const app = new cdk.App();

new SoyleStack(app, "Soyle-Game", {
  env: { account: "339712993262", region: "us-east-1" },
  domainName: "soyle.peachyvoice.com",
  hostedZoneId: "Z07624102EIR18MB78K3H",
  zoneName: "peachyvoice.com",
});

cdk.Tags.of(app).add("project", "soyle");
