//! The cloud pane's state: open or closed, and whether its web view exists yet. The web view is
//! made the first time the pane opens (a closed pane costs nothing and loads nothing), with
//! claude.ai/code or the URL of the `open` command that opened it.

use crate::osc::PaneCommand;
use crate::urls::PANE_HOME;

/// What the host does to carry out a command, in this order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PaneAction {
    /// Make the pane's web view with this first page.
    Create(String),
    /// Load this page in the existing web view.
    Load(String),
    Show,
    Hide,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Pane {
    pub open: bool,
    pub created: bool,
}

impl Pane {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn apply(&mut self, command: &PaneCommand) -> Vec<PaneAction> {
        match command {
            PaneCommand::Open(url) => {
                let mut actions = vec![if self.created { PaneAction::Load(url.clone()) } else { PaneAction::Create(url.clone()) }];
                self.created = true;
                if !self.open {
                    self.open = true;
                    actions.push(PaneAction::Show);
                }
                actions
            }
            PaneCommand::Show => self.show(),
            PaneCommand::Hide => self.hide(),
            PaneCommand::Toggle => {
                if self.open {
                    self.hide()
                } else {
                    self.show()
                }
            }
        }
    }

    fn show(&mut self) -> Vec<PaneAction> {
        let mut actions = Vec::new();
        if !self.created {
            self.created = true;
            actions.push(PaneAction::Create(PANE_HOME.to_string()));
        }
        if !self.open {
            self.open = true;
            actions.push(PaneAction::Show);
        }
        actions
    }

    fn hide(&mut self) -> Vec<PaneAction> {
        if !self.open {
            return Vec::new();
        }
        self.open = false;
        vec![PaneAction::Hide]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_show_makes_the_web_view_with_claude_code() {
        let mut pane = Pane::new();
        assert_eq!(pane.apply(&PaneCommand::Show), vec![PaneAction::Create(PANE_HOME.into()), PaneAction::Show]);
        assert_eq!(pane.apply(&PaneCommand::Show), vec![]);
        assert_eq!(pane.apply(&PaneCommand::Hide), vec![PaneAction::Hide]);
        assert_eq!(pane.apply(&PaneCommand::Hide), vec![]);
        // Shown again: the page it had stays.
        assert_eq!(pane.apply(&PaneCommand::Show), vec![PaneAction::Show]);
    }

    #[test]
    fn open_loads_the_page_and_shows_the_pane() {
        let mut pane = Pane::new();
        let url = "https://claude.ai/code/session_1".to_string();
        assert_eq!(pane.apply(&PaneCommand::Open(url.clone())), vec![PaneAction::Create(url.clone()), PaneAction::Show]);
        assert_eq!(pane.apply(&PaneCommand::Open(url.clone())), vec![PaneAction::Load(url.clone())]);
        pane.apply(&PaneCommand::Hide);
        assert_eq!(pane.apply(&PaneCommand::Open(url.clone())), vec![PaneAction::Load(url), PaneAction::Show]);
    }

    #[test]
    fn toggle_flips() {
        let mut pane = Pane::new();
        assert_eq!(pane.apply(&PaneCommand::Toggle), vec![PaneAction::Create(PANE_HOME.into()), PaneAction::Show]);
        assert!(pane.open);
        assert_eq!(pane.apply(&PaneCommand::Toggle), vec![PaneAction::Hide]);
        assert!(!pane.open);
        assert_eq!(pane.apply(&PaneCommand::Toggle), vec![PaneAction::Show]);
    }
}
