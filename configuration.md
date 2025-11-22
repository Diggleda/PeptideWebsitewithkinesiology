# Automation Commands

Use these shorthand phrases to trigger build-and-zip workflows with the latest version naming convention:

- **build and zip f** – Build the frontend and produce a flattened `.zip` of the frontend bundle using the latest version naming scheme.
- **build and zip b** – Build the backend and produce a `.zip` using the latest version naming scheme.
- **build and zip fb** – Build and zip both frontend (flattened) and backend into a frontend .zip and a backend.zip, each using the latest version naming scheme.

Notes:
- "Flattened" means the frontend zip should contain the build output contents at the root of the archive.
- Always apply the most recent version number format when naming the zip files.
- Always provide individual zips for the frontend and backend
