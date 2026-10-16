@F9
Feature: Provenance of semantic artifacts
  As an operator
  I want every semantic artifact to be traceable
  So that the meaning layer is as auditable as the code

  Background:
    Given a git repository with the semantic layer initialized
    And the semantic engine is the test engine with model "m1"
    And background indexing is disabled
    And I commit a change to "src/retry.ts" with message "Add retry"
    And I run "git sem index"

  Scenario: Inspect an artifact's origin
    When I run "git sem show HEAD --provenance"
    Then the output shows the object hash of HEAD
    And the output shows engine "command", model "m1", prompt "intent/v1" and tier 2
    And the output shows when the artifact was computed

  Scenario: Replay produces a new artifact, not an overwrite
    When the prompt version is changed to "intent/v2"
    And I run "git sem index --rev HEAD"
    Then HEAD has 2 inferred intents
    And HEAD has an inferred intent with prompt "intent/v1"
    And HEAD has an inferred intent with prompt "intent/v2"
