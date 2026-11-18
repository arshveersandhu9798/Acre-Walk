# Fieldnote

A static, mobile-friendly GPS land-boundary tracker. Walk around a plot to record GPS points, estimate its perimeter and area, and save or export surveys.

## Run locally

Open `index.html` from a local web server (GPS browser access requires HTTPS, except on `localhost`). For example:

```sh
python3 -m http.server 8000
```

Then visit `http://localhost:8000`.

## Enable Google sign-in and cloud saving

Cloud sign-in and sync use Firebase Authentication and Cloud Firestore. Surveys are still saved in the current browser on this device when Firebase is not configured.

1. Create a Firebase project at [Firebase Console](https://console.firebase.google.com/).
2. Register a **Web app** in the project and copy its Firebase web configuration into `firebase-config.js`. Firebase web configuration is public client configuration, not a server secret.
3. In **Authentication → Sign-in method**, enable **Google**.
4. In **Authentication → Settings → Authorized domains**, add your local development host and your deployed GitHub Pages and Vercel domains.
5. Create a **Cloud Firestore** database. In **Firestore → Rules**, publish the contents of [`firestore.rules`](./firestore.rules). The rules restrict each signed-in user to their own surveys.
6. Deploy the site over HTTPS. Click **Continue with Google** to sign in; surveys you complete while signed in will sync to your account and remain available on this device.

Keep the Firestore rules in place. Never use public read/write rules for survey data. Sign in with the same Google account to access surveys saved to the cloud. Older surveys saved before signing in stay on that device; use **Export JSON** to download a portable copy.

## Deploy

### GitHub Pages

Push the site files to a GitHub repository. In **Settings → Pages**, choose **Deploy from a branch**, select the branch and root folder, and save. Add the resulting `your-name.github.io` or project Pages domain to Firebase's authorized domains. The relative asset links work from a GitHub project subpath.

### Vercel

Import the GitHub repository into Vercel and deploy with the **Other** framework preset, no build command, and `.` as the output directory. Add the assigned `your-project.vercel.app` domain to Firebase's authorized domains.

## Notes

- GPS tracking needs permission, a location-capable device, and a secure context (HTTPS in production).
- Keep the page open while recording. GPS accuracy varies with the device, terrain, and satellite reception; fixes worse than ±35 m are skipped.
- Choose Metric or Imperial measurements in the survey panel; the preference is saved in the current browser.
- Area is an approximate calculation from the recorded GPS polygon. It is not a legal or cadastral survey. Consult a licensed surveyor for official property boundaries.
- Map tiles are provided by OpenStreetMap; an internet connection is needed to load them.
