import axios from "axios";

interface GithubRelease {
  assets: {
    name: string;
    browser_download_url: string;
  }[];
}

export async function fetchFileFromLatestRelease({
  owner,
  repo,
  fileName,
}: {
  owner: string;
  repo: string;
  fileName: string;
}): Promise<string> {
  try {
    // Get the latest release information
    const releaseResponse = await axios.get<GithubRelease>(
      `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
      {
        headers: {
          Accept: "application/vnd.github.v3+json",
        },
      },
    );

    // Find the asset with matching filename
    const asset = releaseResponse.data.assets.find(
      (asset) => asset.name === fileName,
    );

    if (!asset) {
      throw new Error(`File ${fileName} not found in the latest release`);
    }

    // Download the file
    const fileResponse = await axios.get<string>(asset.browser_download_url, {
      responseType: "text",
    });

    return fileResponse.data;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 404) {
        throw new Error("Repository or release not found");
      }
      throw new Error(`GitHub API error: ${error.message}`);
    }
    throw error;
  }
}
