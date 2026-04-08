import React from 'react'
import { AppRouter, AppRoute } from '@ice/stark'

function App() {
  return (
    <>
      <AppRouter>
        <AppRoute
          name="opencode"
          activePath="/opencode"
          url={[
            "http://localhost:3000/assets/micro-app.css",
            "http://localhost:3000/index.js"
          ]}
          loadScriptMode="import"
        />
      </AppRouter>
    </>
  )
}

export default App
