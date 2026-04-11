# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tmp/issue197-settings.spec.cjs >> issue197 settings page regression
- Location: tmp/issue197-settings.spec.cjs:5:1

# Error details

```
Test timeout of 120000ms exceeded.
```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - navigation "Dashboard navigation" [ref=e2]:
    - link "HAICO Dashboard" [ref=e3] [cursor=pointer]:
      - /url: /
      - text: A
    - button "Inbox" [ref=e4] [cursor=pointer]:
      - img [ref=e6]
      - generic [ref=e8]: Inbox
    - button "Projects" [ref=e9] [cursor=pointer]:
      - img [ref=e11]
      - generic [ref=e13]: Projects
    - button "Usage" [ref=e14] [cursor=pointer]:
      - img [ref=e16]
      - generic [ref=e18]: Usage
    - button "Settings" [ref=e19] [cursor=pointer]:
      - img [ref=e21]
      - generic [ref=e24]: Settings
  - banner [ref=e25]:
    - heading "HAICO" [level=1] [ref=e26]:
      - link "HAICO" [ref=e27] [cursor=pointer]:
        - /url: /
    - generic [ref=e28]:
      - button "+ New Project" [ref=e29] [cursor=pointer]
      - button "Q" [ref=e31] [cursor=pointer]
  - main [ref=e32]:
    - generic [ref=e33]:
      - generic [ref=e35]:
        - generic [ref=e36]: Workspace
        - heading "Settings" [level=2] [ref=e37]
        - paragraph [ref=e38]: Manage dashboard preferences, account actions, and reusable command profiles.
      - generic [ref=e39]:
        - generic [ref=e40]:
          - generic [ref=e42]:
            - heading "Appearance" [level=3] [ref=e43]
            - paragraph [ref=e44]: Choose the theme used across HAICO.
          - generic [ref=e46]:
            - generic [ref=e47]: Theme
            - combobox [ref=e48]:
              - option "GitHub Dark"
              - option "Dracula" [selected]
              - option "Nord Dark"
              - option "Nord Light"
              - option "Monokai"
              - option "Solarized Dark"
              - option "Solarized Light"
        - generic [ref=e49]:
          - generic [ref=e51]:
            - heading "Notifications And Account" [level=3] [ref=e52]
            - paragraph [ref=e53]: Control alerts and access common account actions.
          - generic [ref=e54]:
            - generic [ref=e55]:
              - generic [ref=e56]:
                - text: Notification Sound
                - button "Notification Sound" [ref=e57] [cursor=pointer]
              - generic [ref=e59]: Play a short alert when new actionable work arrives.
            - generic [ref=e60]:
              - generic [ref=e61]: Account
              - generic [ref=e62]:
                - link "Change Password" [ref=e63] [cursor=pointer]:
                  - /url: /change-password
                - link "Logout" [ref=e64] [cursor=pointer]:
                  - /url: "#"
      - generic [ref=e65]:
        - generic [ref=e67]:
          - heading "Command Profiles" [level=3] [ref=e68]
          - paragraph [ref=e69]: Manage reusable CLI presets for agent creation and editing.
        - generic [ref=e72]:
          - generic [ref=e73]: Command Profiles
          - generic [ref=e74]: Reusable CLI presets for agent creation and editing.
          - table [ref=e76]:
            - rowgroup [ref=e77]:
              - row "Name Command Type Actions" [ref=e78]:
                - columnheader "Name" [ref=e79]
                - columnheader "Command" [ref=e80]
                - columnheader "Type" [ref=e81]
                - columnheader "Actions" [ref=e82]
            - rowgroup [ref=e83]:
              - row "QA Profile cld --model qa-test-2 Codex Save Delete" [ref=e84]:
                - cell "QA Profile" [ref=e85]:
                  - textbox "Name" [ref=e86]: QA Profile
                - cell "cld --model qa-test-2" [ref=e87]:
                  - textbox "Command" [ref=e88]: cld --model qa-test-2
                - cell "Codex" [ref=e89]:
                  - combobox [ref=e90]:
                    - option "Claude"
                    - option "Codex" [selected]
                    - option "Gemini"
                - cell "Save Delete" [ref=e91]:
                  - generic [ref=e92]:
                    - button "Save" [ref=e93] [cursor=pointer]
                    - button "Delete" [ref=e94] [cursor=pointer]
              - row "Claude Add" [ref=e95]:
                - cell [ref=e96]:
                  - textbox "New profile" [ref=e97]
                - cell [ref=e98]:
                  - textbox "cld --model claude-sonnet-4-6" [ref=e99]
                - cell "Claude" [ref=e100]:
                  - combobox [ref=e101]:
                    - option "Claude" [selected]
                    - option "Codex"
                    - option "Gemini"
                - cell "Add" [ref=e102]:
                  - button "Add" [ref=e104] [cursor=pointer]
```