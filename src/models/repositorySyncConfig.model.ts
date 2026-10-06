export class RepositorySyncConfig {
  public provider: "github" | "gitlab" = "github";
  public apiUrl = "https://api.github.com";
  public token = "";
  public repository = "";
  public branch = "master";
}
