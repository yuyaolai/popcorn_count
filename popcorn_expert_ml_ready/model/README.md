# Model Slot

Place a TensorFlow.js Layers model here if you want the app to use a trained classifier.

Expected files:

- `model.json`
- `group1-shard*.bin`

The app will try to load `./model/model.json` automatically.

If you train a model from popcorn recordings, make sure the model input matches the feature vector used in `app.js`.
