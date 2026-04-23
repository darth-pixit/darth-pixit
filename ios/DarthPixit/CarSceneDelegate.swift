import UIKit
import CarPlay

// Bridges the CarPlay window lifecycle to react-native-carplay's RNCarPlay module.
// RNCarPlay.connect / disconnect propagate the CarPlay connection state to the JS layer
// so that CarPlayService.ts can build and update templates.
@objc(CarSceneDelegate)
class CarSceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {

  func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didConnect interfaceController: CPInterfaceController
  ) {
    RNCarPlay.connect(
      withInterfaceController: interfaceController,
      window: templateApplicationScene.carWindow
    )
  }

  func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didDisconnectInterfaceController interfaceController: CPInterfaceController,
    fromWindow window: CPWindow
  ) {
    RNCarPlay.disconnect()
  }
}
