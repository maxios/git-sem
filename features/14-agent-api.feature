@F14 @wip
Feature: Agent access to semantics
  As an AI agent working in the repo
  I want structured access to intents, entities, and history
  So that I can reason about the codebase without re-reading it

  Scenario: Query entities as structured data
    When the agent calls "sem.entity('loadUser')"
    Then it receives JSON with versions, intents, and commit hashes

  Scenario: Agent proposals are recorded as states
    Given an agent proposes an intent or a merge suggestion
    When the proposal is stored
    Then it is tagged with the agent identity and provenance
    And it remains a proposal until a user accepts it
