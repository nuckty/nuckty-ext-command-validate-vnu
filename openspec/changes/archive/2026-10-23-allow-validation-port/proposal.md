# Validation port

## Why
Complete the requested beta1 publication checks and bilingual demo.

## What Changes
The validate command SHALL accept --port with an integer from 1 through 65535, default to 8888 and reject invalid values before starting Java.

## Impact
Local source preparation and checks only; no commits, push or deployment.
