@F14
Feature: Agent access to semantics
  As an AI agent working in the repo
  I want structured access to intents, entities, and history
  So that I can reason about the codebase without re-reading it

  Background:
    Given a git repository with the semantic layer initialized
    And the semantic engine is the test engine with model "m1"
    And background indexing is disabled
    And I commit "api/user.ts" with a function "fetchUser"
    And I rename the function "fetchUser" to "loadUser" and move it to "services/user.ts"
    And I run "git sem index"

  Scenario: Query entities as structured data
    When an agent calls entity "loadUser" through the library
    Then it receives JSON with versions, intents and commit hashes for "loadUser"
    And the engine has been invoked 2 times

  Scenario: Agents can use git-sem over MCP
    When an agent calls the MCP tool "sem_entity" with name "loadUser"
    Then it receives JSON with versions, intents and commit hashes for "loadUser"

  Scenario: Agent proposals are recorded as states
    When I run "git sem intent HEAD --propose 'Move user loading behind the service layer' --agent claude"
    Then HEAD has a proposal from agent "claude"
    And HEAD has no authored intent
    When I run "git sem intent HEAD --accept --agent claude"
    Then HEAD shows the authored intent "Move user loading behind the service layer"

  Scenario: Proposals made over MCP carry the agent's identity
    When an agent named "reviewer-bot" proposes "Rename for clarity" for HEAD over MCP
    Then HEAD has a proposal from agent "reviewer-bot"
    And HEAD has no authored intent
