# ADR-<DOMAIN>[-<SUBDOMAIN>]-<NNNN>: Decision title

The sections below are recommended prompts, not a required schema. Keep the
sections that preserve useful decision context, rename or omit those that do
not fit, and add domain-specific evidence where it helps. The ADR validator
enforces only the filename, heading, date, status, identifier uniqueness,
companion-directory ownership, and resolvable ADR links.

Date: YYYY-MM-DD

Relation: <Builds on | Refines | Amends | Supersedes> ADR-<DOMAIN>-<NNNN>. State
what remains true in that ADR. Omit this line when the ADR stands alone.

## Status

Proposed

## Context

Describe the forces and constraints that make a durable decision necessary.

## Decision

State the chosen direction, boundaries, and invariants. Name how implementation
will prove them; for production behavior, include health and rollback evidence.

## Alternatives considered

Record viable alternatives and why they were not chosen.

## What we reject

Record patterns later work must not introduce and why. These are standing rules,
distinct from alternatives considered at decision time.

## Consequences

Record positive, negative, operational, and migration consequences. Name known
limits explicitly, including why each gap remains open.

## Revisit triggers

State measurable conditions that reopen this decision after acceptance, including
the value and direction that matter.
