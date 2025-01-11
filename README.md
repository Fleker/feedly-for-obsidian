# Feedly for Obsidian

If you are _a paid member_ of Feedly, you are able to annotate articles and add comments to them as well. Those are all stored in Feedly's web UI. This plugin makes it easy for users to sync these annotations and comments to a folder in Obsidian, with a file created for each article and each file containing as many highlights as you've added.

## Setup

1. [Sign into Feedly](https://feedly.com/v3/auth/dev) and get a developer access token
1. Take note of your user ID and access token
1. Save those values in the plugin settings
1. Run **Feedly Annotations Sync: Sync Annotated Articles**

**Note**: Your access token expires after a month. Then you must obtain a new one.

Feedly's API has a daily rate limit. So the first time you run the sync, it may end with a `429 error` before being complete. If so, then the plugin will pick back up in the same spot tomorrow.

By default, all files will be placed in a directory called `Feedly Annotations` but that can be changed in the plugin settings.

## Example

You open up the command palette and run the **Feedly Annotationns Sync** command. Each file will include frontmatter metadata which includes pertinent information and is followed by annotations in quotes and comments.

Example: `Feedly Annotations/How Will AI Affect the Semiconductor Industry.md`

```md
---
url: https://spectrum.ieee.org/how-will-ai-change-semiconductors
feedlyUrl: https://feedly.com/i/entry/qVaITo2WE8WUK65sE/5QyhWry8ByR703aSjyCZVKs9g=_18bd413beb9:26e5afa:1883a5ef
date: 2023-11-23
pubDate: 2023-11-15
author: Tekla S. Perry
publisher: IEEE Spectrum
---


> Gavrielov recalled the transition to electronic-design automation (EDA), the last big change in chip design. That transition, he says, was a 30-plus-year process. “I think the transition that AI will bring will happen in a third to a fifth of the time and will have a much bigger impact,” he said. “In five years, for sure in less than 10 years, design will be done in a very different way than today.”
```

The `date` refers to the date of the annotations whereas `pubDate` is the actual date of publication.

This plugin could use your feedback and help to make it a success!
